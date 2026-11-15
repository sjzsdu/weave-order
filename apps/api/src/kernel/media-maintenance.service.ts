import { sampleImages } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { ObjectStorage } from "../platform/storage";
import { reencodeOversizedOriginal } from "../platform/thumbnail";
import type { SampleThumbService } from "./sample-thumbs.service";

/** 超过这个体积的原图会被重编码（问题单口径：2MB）。 */
export const DEFAULT_MAX_ORIGINAL_BYTES = 2 * 1024 * 1024;
/** 未被 DB 引用的对象至少放这么久才回收，避免删掉「刚 PUT、还没 confirm」的对象。 */
export const DEFAULT_ORPHAN_GRACE_HOURS = 24;
/**
 * 移动端「以图找样」上传的查询图（`tenant/<tid>/uploads/`）保留期，默认 7 天。
 *
 * 为什么不立刻删：查询图是**一次性**对象（不入库、不回显给客户），但一次找样可能
 * 在页面里反复重试、用户在拍照页停留数分钟、或在弱网下延迟续传；按天级保留期回收，
 * 既能控住桶体积，也不会在用户还没挑完候选时把图删掉导致「重试就失败」。
 * 另外这个值保守，是因为误删的代价（客户投诉「找样一直失败」）远大于多存几天几十 MB。
 */
export const DEFAULT_QUERY_UPLOAD_RETENTION_HOURS = 7 * 24;

export interface ThumbBackfillReport {
  tenantId: string;
  dryRun: boolean;
  /** 待处理（pending / failed / key 缺失）总数。 */
  pending: number;
  derived: number;
  failed: { imageId: string; message: string }[];
}

export interface OriginalCompressReport {
  tenantId: string;
  dryRun: boolean;
  thresholdBytes: number;
  scanned: number;
  compressed: number;
  /** 重编码后反而更大 / 没有收益而跳过的数量。 */
  skipped: number;
  savedBytes: number;
  failures: { imageId: string; message: string }[];
}

export interface OrphanCleanupReport {
  tenantId: string;
  dryRun: boolean;
  listed: number;
  /** 列举到的对象总占用（字节）：先量化再删，避免「清理逻辑写错就批量删库」。 */
  listedBytes: number;
  referenced: number;
  candidates: number;
  /** 本轮可删对象的占用（字节）。 */
  candidateBytes: number;
  deleted: number;
  deletedBytes: number;
  /** 还在保护期内（可能正在上传/确认）而保留的数量。 */
  skippedWithinGrace: number;
  /** 存储没给 lastModified，无法判断年龄：保守保留。 */
  skippedUnknownAge: number;
  failures: { key: string; message: string }[];
}

/** 查询图（`uploads/`）回收报告：口径与孤儿对象一致，先给条数与字节再动手。 */
export interface QueryUploadCleanupReport {
  tenantId: string;
  dryRun: boolean;
  retentionHours: number;
  listed: number;
  listedBytes: number;
  candidates: number;
  candidateBytes: number;
  deleted: number;
  deletedBytes: number;
  /** 仍被 `sample_images` 引用（`imageKeys` 允许 `uploads/`）而保留的数量。 */
  skippedReferenced: number;
  skippedReferencedBytes: number;
  /** 未超过保留期：可能是正在进行的找样，保留。 */
  skippedWithinRetention: number;
  /** 存储没给 lastModified：无法判断年龄，保守保留。 */
  skippedUnknownAge: number;
  failures: { key: string; message: string }[];
}

/**
 * 存量媒体治理：补派生 / 超大原图重编码 / 孤儿对象回收。
 *
 * 三个动作都设计成可重复执行：
 * - 补派生只看 `thumb_status != ready`，成功后再跑就是 0 条；
 * - 重编码只看 `byte_size > 阈值`，压完就落到阈值以下；
 * - 孤儿只删「桶里有、DB 里没有、且超过保护期」的对象。
 */
export class MediaMaintenanceService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly storage: ObjectStorage | null,
    private readonly thumbs: SampleThumbService,
  ) {}

  async backfillThumbs(
    options: { dryRun?: boolean; limit?: number; force?: boolean } = {},
  ): Promise<ThumbBackfillReport> {
    const dryRun = options.dryRun ?? false;
    const limit = Math.max(1, options.limit ?? 500);
    const pending = await this.thumbs.pendingCount();
    const report: ThumbBackfillReport = {
      tenantId: this.tenantId,
      dryRun,
      pending,
      derived: 0,
      failed: [],
    };
    if (dryRun || pending === 0) return report;

    // 先取一份待办快照，每张图本轮只处理一次。
    //
    // 为什么不再「每页重查 pending」：派生失败的行仍然是 pending，
    // 重查会把同一批损坏图反复捞回来（重复读原图 + 跑两遍 sharp），
    // 报告里也会为同一张图刷出大量重复失败。一次快照 + 逐条处理，
    // 既能保证幂等（下轮再处理剩下的），也不会放大失败成本。
    const ids = await this.thumbs.pendingImageIds(limit);
    for (const imageId of ids) {
      try {
        const outcome = await this.thumbs.derive(imageId, { force: options.force });
        if (outcome === "ready") report.derived += 1;
      } catch (error) {
        report.failed.push({
          imageId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  }

  async compressOversizedOriginals(
    options: { dryRun?: boolean; limit?: number; thresholdBytes?: number } = {},
  ): Promise<OriginalCompressReport> {
    const dryRun = options.dryRun ?? false;
    const thresholdBytes = options.thresholdBytes ?? DEFAULT_MAX_ORIGINAL_BYTES;
    const limit = Math.max(1, options.limit ?? 200);
    const rows = await this.db
      .select()
      .from(sampleImages)
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          gt(sampleImages.byteSize, thresholdBytes),
          // 已治理过的行不再重复压：重编码会轻微改变字节，不标记就会「每次跑都再压一点」。
          isNull(sampleImages.reencodedAt),
        ),
      )
      .orderBy(asc(sampleImages.createdAt))
      .limit(limit);

    const report: OriginalCompressReport = {
      tenantId: this.tenantId,
      dryRun,
      thresholdBytes,
      scanned: rows.length,
      compressed: 0,
      skipped: 0,
      savedBytes: 0,
      failures: [],
    };
    if (!this.storage) {
      throw new Error("对象存储未配置，无法重编码原图");
    }

    for (const row of rows) {
      try {
        const object = await this.storage.get(row.objectKey);
        if (!object) throw new Error(`对象不存在：${row.objectKey}`);
        const reencoded = await reencodeOversizedOriginal(object.bytes, row.mimeType);
        const saved = row.byteSize - reencoded.bytes.length;
        // 重编码后反而更大（例如已高度压缩的 webp）：不动原对象，避免负优化。
        if (saved <= 0) {
          report.skipped += 1;
          if (!dryRun) {
            // 记成「已治理但无收益」，否则每轮都会重新解码一遍。
            await this.db
              .update(sampleImages)
              .set({ originalByteSize: row.byteSize, reencodedAt: new Date() })
              .where(and(eq(sampleImages.id, row.id), eq(sampleImages.tenantId, this.tenantId)));
          }
          continue;
        }
        report.savedBytes += saved;
        if (dryRun) {
          report.compressed += 1;
          continue;
        }
        // 原 key 不变、覆盖写：本任务不做图片版本管理（见 PR 说明）。
        await this.storage.put(row.objectKey, reencoded.bytes, reencoded.contentType);
        await this.db
          .update(sampleImages)
          .set({
            byteSize: reencoded.bytes.length,
            mimeType: reencoded.contentType,
            width: reencoded.width ?? row.width,
            height: reencoded.height ?? row.height,
            originalByteSize: row.originalByteSize ?? row.byteSize,
            reencodedAt: new Date(),
          })
          .where(and(eq(sampleImages.id, row.id), eq(sampleImages.tenantId, this.tenantId)));
        report.compressed += 1;
      } catch (error) {
        report.failures.push({
          imageId: row.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  }

  async cleanupOrphanedObjects(
    options: { dryRun?: boolean; graceHours?: number } = {},
  ): Promise<OrphanCleanupReport> {
    const dryRun = options.dryRun ?? false;
    const graceHours = options.graceHours ?? DEFAULT_ORPHAN_GRACE_HOURS;
    if (!this.storage) throw new Error("对象存储未配置，无法回收孤儿对象");
    if (!this.storage.list) {
      throw new Error("当前对象存储实现不支持列举（ObjectStorage.list），无法回收孤儿对象");
    }
    // 先证明「引用集合是完整的」，再谈删除。RLS 让业务角色看不到未设置
    // `app.tenant_id` 的行，引用集合会恒为空，一执行就是删光整租户原图。
    await this.assertCleanupScope();
    // 只扫样品图片前缀：`uploads/` 由 cleanupQueryUploads 处理（带引用白名单），
    // `receipts/` 属于回款凭证、明确不回收，误删会造成凭证丢失。
    const prefix = `tenant/${this.tenantId}/samples/`;
    const listed = await this.storage.list(prefix);

    const referenced = await this.referencedImageKeys();

    const cutoff = Date.now() - graceHours * 3600_000;
    const report: OrphanCleanupReport = {
      tenantId: this.tenantId,
      dryRun,
      listed: listed.length,
      listedBytes: listed.reduce((sum, object) => sum + object.size, 0),
      referenced: referenced.size,
      candidates: 0,
      candidateBytes: 0,
      deleted: 0,
      deletedBytes: 0,
      skippedWithinGrace: 0,
      skippedUnknownAge: 0,
      failures: [],
    };

    for (const object of listed) {
      if (referenced.has(object.key)) continue;
      if (!object.lastModified) {
        report.skippedUnknownAge += 1;
        continue;
      }
      if (object.lastModified.getTime() > cutoff) {
        report.skippedWithinGrace += 1;
        continue;
      }
      report.candidates += 1;
      report.candidateBytes += object.size;
      if (dryRun) continue;
      try {
        await this.storage.delete(object.key);
        report.deleted += 1;
        report.deletedBytes += object.size;
      } catch (error) {
        report.failures.push({
          key: object.key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  }

  /**
   * 回收「以图找样」上传的查询图（`tenant/<tid>/uploads/`）。
   *
   * 这些对象从来不入库：presign 不带 `sampleId` 时 key 落在 `uploads/` 下，
   * 客户端把图交给 T-001 `imageUrl` 变体后就算用完，没有任何 DB 行能证明它还被引用。
   * 所以回收判据只能是「对象年龄 > 保留期」，不能用引用反查。
   *
   * 安全边界：
   * - 只扫本租户 `uploads/` 前缀，`samples/` 由孤儿回收负责、`receipts/` 是回款凭证绝不碰；
   * - 默认 7 天保留期，`--dry-run` 只统计不删；
   * - 报告里先给条数与字节（`listed*` / `candidate*`），再给实际删除数；
   * - 幂等：删掉的对象不会出现在下一次列举里，剩下的就是「还不够老」的。
   */
  async cleanupQueryUploads(
    options: { dryRun?: boolean; retentionHours?: number } = {},
  ): Promise<QueryUploadCleanupReport> {
    const dryRun = options.dryRun ?? false;
    const retentionHours = options.retentionHours ?? DEFAULT_QUERY_UPLOAD_RETENTION_HOURS;
    if (!this.storage) throw new Error("对象存储未配置，无法回收查询图");
    if (!this.storage.list) {
      throw new Error("当前对象存储实现不支持列举（ObjectStorage.list），无法回收查询图");
    }
    // 与孤儿回收同一道自检：引用集合不完整时，下一行「跳过被引用对象」就是空的。
    await this.assertCleanupScope();
    const prefix = `tenant/${this.tenantId}/uploads/`;
    const listed = await this.storage.list(prefix);
    // `uploads/` 不是「从不入库」：`POST /api/samples` 的 `imageKeys` 明确接受
    // `tenant/<tid>/uploads/<uuid>.<ext>`（先直传、再随建样品提交）。按年龄直接删
    // 会让第 8 天的图墙裂图，所以必须用本租户 `sample_images` 的引用做白名单。
    const referenced = await this.referencedImageKeys();
    const cutoff = Date.now() - retentionHours * 3600_000;
    const report: QueryUploadCleanupReport = {
      tenantId: this.tenantId,
      dryRun,
      retentionHours,
      listed: listed.length,
      listedBytes: listed.reduce((sum, object) => sum + object.size, 0),
      candidates: 0,
      candidateBytes: 0,
      deleted: 0,
      deletedBytes: 0,
      skippedReferenced: 0,
      skippedReferencedBytes: 0,
      skippedWithinRetention: 0,
      skippedUnknownAge: 0,
      failures: [],
    };

    for (const object of listed) {
      if (referenced.has(object.key)) {
        report.skippedReferenced += 1;
        report.skippedReferencedBytes += object.size;
        continue;
      }
      if (!object.lastModified) {
        report.skippedUnknownAge += 1;
        continue;
      }
      if (object.lastModified.getTime() > cutoff) {
        report.skippedWithinRetention += 1;
        continue;
      }
      report.candidates += 1;
      report.candidateBytes += object.size;
      if (dryRun) continue;
      try {
        await this.storage.delete(object.key);
        report.deleted += 1;
        report.deletedBytes += object.size;
      } catch (error) {
        report.failures.push({
          key: object.key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  }

  /**
   * 破坏性清理前的租户上下文自检。
   *
   * `sample_images` 与 `tenants` 都是 FORCE RLS：业务角色（`weave_app`，NOBYPASSRLS）
   * 没有设置 `app.tenant_id` 时查不到任何行。此时「未被引用」会把**所有**对象都判成孤儿。
   * 所以两条路只允许一条：
   * - 当前角色 BYPASSRLS / SUPERUSER（能看全量引用，是高权限运维连接）；
   * - 或会话已把 `app.tenant_id` 设成本租户（`withTenantSession` / `set_config`）。
   * 都不满足就拒绝执行，绝不带着空引用集合删数据。
   */
  private async assertCleanupScope(): Promise<void> {
    const result = (await this.db.execute(sql`
      SELECT current_setting('app.tenant_id', true) AS tenant_id,
             (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls
    `)) as unknown as {
      rows?: { tenant_id: string | null; bypasses_rls: boolean | null }[];
    };
    const row = result.rows?.[0];
    if (!row) {
      throw new Error("无法确认数据库租户上下文（current_setting 查询无结果），拒绝执行清理");
    }
    if (row.bypasses_rls === true) return;
    if (row.tenant_id !== this.tenantId) {
      throw new Error(
        "拒绝执行清理：当前连接没有设置 app.tenant_id，而数据库角色受 RLS 约束，" +
          "引用集合会为空并导致误删整租户对象。请用 CLI（按租户自动开启 withTenantSession），" +
          `或手工执行 SELECT set_config('app.tenant_id', '${this.tenantId}', false) 后再跑；` +
          "不要用业务角色直连后直接调用清理。",
      );
    }
  }

  /** 本租户 `sample_images` 引用的所有对象 key（原图 + 两档缩略图）。 */
  private async referencedImageKeys(): Promise<Set<string>> {
    const rows = await this.db
      .select({
        objectKey: sampleImages.objectKey,
        thumb320Key: sampleImages.thumb320Key,
        thumb640Key: sampleImages.thumb640Key,
      })
      .from(sampleImages)
      .where(eq(sampleImages.tenantId, this.tenantId));
    const referenced = new Set<string>();
    for (const row of rows) {
      referenced.add(row.objectKey);
      if (row.thumb320Key) referenced.add(row.thumb320Key);
      if (row.thumb640Key) referenced.add(row.thumb640Key);
    }
    return referenced;
  }

  /** 统计信息（CLI 报告用）。 */
  async counts(): Promise<{ images: number; oversized: number; thumbsPending: number }> {
    const images = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sampleImages)
      .where(eq(sampleImages.tenantId, this.tenantId));
    const oversized = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sampleImages)
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          gt(sampleImages.byteSize, DEFAULT_MAX_ORIGINAL_BYTES),
          isNull(sampleImages.reencodedAt),
        ),
      );
    return {
      images: images[0]?.count ?? 0,
      oversized: oversized[0]?.count ?? 0,
      thumbsPending: await this.thumbs.pendingCount(),
    };
  }
}
