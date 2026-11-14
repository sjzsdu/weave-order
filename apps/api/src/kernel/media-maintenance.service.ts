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
  referenced: number;
  candidates: number;
  deleted: number;
  /** 还在保护期内（可能正在上传/确认）而保留的数量。 */
  skippedWithinGrace: number;
  /** 存储没给 lastModified，无法判断年龄：保守保留。 */
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

    // 分页处理：成功的行会从 pending 里消失，所以每页都重新查「还缺哪些」。
    // 失败行仍留在 pending，靠 processed 上限终止，避免死循环。
    let processed = 0;
    while (processed < limit) {
      const pageSize = Math.min(200, limit - processed);
      const ids = await this.thumbs.pendingImageIds(pageSize);
      if (ids.length === 0) break;
      processed += ids.length;
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
      // 全页都失败时 pending 不会缩小，不要原地打转。
      if (report.failed.length === ids.length && report.derived === 0) break;
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
    // 只扫样品图片前缀：`uploads/` 是未确认的临时直传、`receipts/` 属于回款凭证，
    // 两者的生命周期不归这里管，误删会造成凭证丢失。
    const prefix = `tenant/${this.tenantId}/samples/`;
    const listed = await this.storage.list(prefix);

    const referencedRows = await this.db
      .select({
        objectKey: sampleImages.objectKey,
        thumb320Key: sampleImages.thumb320Key,
        thumb640Key: sampleImages.thumb640Key,
      })
      .from(sampleImages)
      .where(eq(sampleImages.tenantId, this.tenantId));
    const referenced = new Set<string>();
    for (const row of referencedRows) {
      referenced.add(row.objectKey);
      if (row.thumb320Key) referenced.add(row.thumb320Key);
      if (row.thumb640Key) referenced.add(row.thumb640Key);
    }

    const cutoff = Date.now() - graceHours * 3600_000;
    const report: OrphanCleanupReport = {
      tenantId: this.tenantId,
      dryRun,
      listed: listed.length,
      referenced: referenced.size,
      candidates: 0,
      deleted: 0,
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
      if (dryRun) continue;
      try {
        await this.storage.delete(object.key);
        report.deleted += 1;
      } catch (error) {
        report.failures.push({
          key: object.key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
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
