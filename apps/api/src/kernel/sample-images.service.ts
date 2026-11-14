import { sampleImages, samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import type { SampleImageVariant } from "@weave-order/schema";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation, uniqueViolationConstraint } from "./errors";
import { loadEnv } from "../platform/env";
import type { Env } from "../platform/env";
import { mediaBaseUrl } from "../platform/storage";
import type { ObjectStorage } from "../platform/storage";

export type SampleImageRow = typeof sampleImages.$inferSelect;

/** 写入一张样品图片：元信息全部来自 `POST /api/media/confirm` 的 HEAD 结果。 */
export interface AttachSampleImageInput {
  sampleId: string;
  objectKey: string;
  variant: SampleImageVariant;
  isPrimary: boolean;
  mimeType: string;
  byteSize: number;
  width?: number | null;
  height?: number | null;
  sortOrder?: number;
}

/** 已校验的对象存储图片：元信息来自 confirm 时的 HEAD，不接受客户端自述。 */
export interface ResolvedImageKey {
  objectKey: string;
  mimeType: string;
  byteSize: number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * 客户端只能引用本租户 `tenant/<tenantId>/(samples|uploads)/...` 下的图片。
 * 路径里的租户 id 是唯一的租户凭证 —— 别家 key 直接 400，不泄露 key 内容。
 */
const TENANT_KEY_PATTERN =
  /^tenant\/([0-9a-fA-F-]{36})\/(samples|uploads)\/(?:[0-9a-fA-F-]{36}\/)?([0-9a-fA-F-]{36})\.(jpg|jpeg|png|webp)$/;

/**
 * 样品图片内核服务：`sample_images` 的唯一写入入口。
 *
 * 不在这里拼 URL、不碰对象存储——那是 platform/storage 与 media 层的事。
 * 删除样品时由数据库外键级联清行；桶里的对象回收是 P1 的后台任务（见 storage.ts TODO）。
 */
export class SampleImageService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly storage: ObjectStorage | null = null,
    private readonly env: Env = loadEnv(),
  ) {}

  /**
   * 校验一组 objectKey 确实已上传、且属于当前租户。
   *
   * `create` / `update` 直接收 key（客户端已完成直传），所以不能只信字符串：
   * 每个 key 都要 HEAD 一次，并用 HEAD 回来的 mime / 体积覆盖客户端声明。
   */
  async resolveKeys(keys: string[]): Promise<ResolvedImageKey[]> {
    if (keys.length === 0) return [];
    if (new Set(keys).size !== keys.length) {
      throw new KernelError("KERNEL_REJECTED", "同一张图片不能重复添加", {
        reason: "SAMPLE_IMAGE_DUPLICATE",
      });
    }
    if (!this.storage) {
      throw new KernelError("KERNEL_REJECTED", "对象存储未配置，无法挂载图片", {
        reason: "MEDIA_STORAGE_UNAVAILABLE",
      });
    }
    const resolved: ResolvedImageKey[] = [];
    for (const objectKey of keys) {
      const match = TENANT_KEY_PATTERN.exec(objectKey);
      if (!match) {
        throw new KernelError("KERNEL_REJECTED", "objectKey 不是本接口签发的图片路径", {
          reason: "MEDIA_KEY_INVALID",
        });
      }
      if (match[1] !== this.tenantId) {
        throw new KernelError("KERNEL_REJECTED", "objectKey 不属于当前租户", {
          reason: "MEDIA_KEY_OUTSIDE_TENANT",
        });
      }
      const extension = match[4] as string;
      const head = await this.storage.head(objectKey);
      if (!head) {
        throw new KernelError("KERNEL_REJECTED", "对象不存在：客户端还没有完成上传", {
          reason: "MEDIA_NOT_UPLOADED",
        });
      }
      const declaredMime = MIME_BY_EXTENSION[extension] ?? "";
      const actualMime = (head.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (actualMime && actualMime !== declaredMime) {
        throw new KernelError("KERNEL_REJECTED", "对象类型与扩展名不一致", {
          reason: "MEDIA_CONTENT_TYPE_MISMATCH",
        });
      }
      const byteSize = head.contentLength;
      if (byteSize === null || byteSize <= 0) {
        throw new KernelError("KERNEL_REJECTED", "对象体积不可信，拒绝写入", {
          reason: "MEDIA_SIZE_UNKNOWN",
        });
      }
      if (byteSize > this.env.MEDIA_MAX_BYTES) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `图片超过体积上限（${this.env.MEDIA_MAX_BYTES} 字节）`,
          { reason: "MEDIA_TOO_LARGE" },
        );
      }
      resolved.push({ objectKey, mimeType: declaredMime, byteSize });
    }
    return resolved;
  }

  /**
   * 在一次事务里把样品的图片组同步成 `resolved` 的顺序。
   *
   * 主图切换先整体清零再设新主图：部分唯一索引 `primary_per_sample`
   * 在同一事务内也不允许中间态出现两张主图。
   */
  async replaceWithin(
    tx: Tx,
    sampleId: string,
    resolved: ResolvedImageKey[],
    primaryKey: string | null | undefined,
  ): Promise<void> {
    const existing = await tx
      .select()
      .from(sampleImages)
      .where(and(eq(sampleImages.tenantId, this.tenantId), eq(sampleImages.sampleId, sampleId)));
    const byKey = new Map(existing.map((row) => [row.objectKey, row]));
    const desiredKeys = resolved.map((entry) => entry.objectKey);
    if (primaryKey != null && !desiredKeys.includes(primaryKey)) {
      throw new KernelError("KERNEL_REJECTED", "主图必须包含在 imageKeys 里", {
        reason: "SAMPLE_PRIMARY_IMAGE_NOT_IN_LIST",
      });
    }

    // 先清空主图，避免「先设新主图」撞上唯一索引。
    await tx
      .update(sampleImages)
      .set({ isPrimary: false })
      .where(and(eq(sampleImages.tenantId, this.tenantId), eq(sampleImages.sampleId, sampleId)));

    if (desiredKeys.length === 0) {
      await tx
        .delete(sampleImages)
        .where(and(eq(sampleImages.tenantId, this.tenantId), eq(sampleImages.sampleId, sampleId)));
      return;
    }
    await tx
      .delete(sampleImages)
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          eq(sampleImages.sampleId, sampleId),
          notInArray(sampleImages.objectKey, desiredKeys),
        ),
      );

    for (const [index, image] of resolved.entries()) {
      const row = byKey.get(image.objectKey);
      if (row) {
        await tx.update(sampleImages).set({ sortOrder: index }).where(eq(sampleImages.id, row.id));
        continue;
      }
      await tx.insert(sampleImages).values({
        tenantId: this.tenantId,
        sampleId,
        objectKey: image.objectKey,
        variant: "primary",
        isPrimary: false,
        mimeType: image.mimeType,
        byteSize: image.byteSize,
        sortOrder: index,
      });
    }

    const previousPrimary = existing.find((row) => row.isPrimary)?.objectKey;
    const primary =
      primaryKey ??
      (previousPrimary && desiredKeys.includes(previousPrimary) ? previousPrimary : desiredKeys[0]);
    if (primary) {
      await tx
        .update(sampleImages)
        .set({ isPrimary: true })
        .where(
          and(
            eq(sampleImages.tenantId, this.tenantId),
            eq(sampleImages.sampleId, sampleId),
            eq(sampleImages.objectKey, primary),
          ),
        );
    }
  }

  /** 按图片 ID 取已挂在本样品上的行，按传入顺序返回（用于排序 / 删除）。 */
  async resolveIds(sampleId: string, ids: string[]): Promise<ResolvedImageKey[]> {
    if (ids.length === 0) return [];
    if (new Set(ids).size !== ids.length) {
      throw new KernelError("KERNEL_REJECTED", "图片列表里有重复项", {
        reason: "SAMPLE_IMAGE_DUPLICATE",
      });
    }
    const rows = await this.db
      .select()
      .from(sampleImages)
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          eq(sampleImages.sampleId, sampleId),
          inArray(sampleImages.id, ids),
        ),
      );
    if (rows.length !== ids.length) {
      throw new KernelError("KERNEL_REJECTED", "图片不属于该样品", {
        reason: "SAMPLE_IMAGE_NOT_FOUND",
      });
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => {
      const row = byId.get(id)!;
      return { objectKey: row.objectKey, mimeType: row.mimeType, byteSize: row.byteSize };
    });
  }

  /** 只切换主图，不动图片组顺序（`PATCH` 只传 primaryImageKey 的场景）。 */
  async setPrimaryWithin(tx: Tx, sampleId: string, primaryKey: string): Promise<void> {
    const rows = await tx
      .select({ id: sampleImages.id })
      .from(sampleImages)
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          eq(sampleImages.sampleId, sampleId),
          eq(sampleImages.objectKey, primaryKey),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new KernelError("KERNEL_REJECTED", "主图不存在于该样品", {
        reason: "SAMPLE_PRIMARY_IMAGE_NOT_FOUND",
      });
    }
    await tx
      .update(sampleImages)
      .set({ isPrimary: false })
      .where(and(eq(sampleImages.tenantId, this.tenantId), eq(sampleImages.sampleId, sampleId)));
    await tx.update(sampleImages).set({ isPrimary: true }).where(eq(sampleImages.id, rows[0]!.id));
  }

  /** 按样品批量取图，供列表页一次查询避免 N+1。 */
  async listForSampleIds(sampleIds: string[]): Promise<Map<string, SampleImageRow[]>> {
    const grouped = new Map<string, SampleImageRow[]>();
    if (sampleIds.length === 0) return grouped;
    const rows = await this.db
      .select()
      .from(sampleImages)
      .where(
        and(eq(sampleImages.tenantId, this.tenantId), inArray(sampleImages.sampleId, sampleIds)),
      )
      .orderBy(asc(sampleImages.sortOrder), asc(sampleImages.createdAt));
    for (const row of rows) {
      const bucket = grouped.get(row.sampleId) ?? [];
      bucket.push(row);
      grouped.set(row.sampleId, bucket);
    }
    return grouped;
  }

  async listForSample(sampleId: string): Promise<SampleImageRow[]> {
    return await this.db
      .select()
      .from(sampleImages)
      .where(and(eq(sampleImages.tenantId, this.tenantId), eq(sampleImages.sampleId, sampleId)))
      .orderBy(asc(sampleImages.sortOrder), asc(sampleImages.createdAt), asc(sampleImages.id));
  }

  /** 读模型里的图片 URL：优先 CDN，未配时退回签名 URL；无存储时返回 null。 */
  async urlFor(objectKey: string): Promise<string | null> {
    if (this.env.MEDIA_BASE_URL) return `${mediaBaseUrl(this.env)}/${objectKey}`;
    if (!this.storage) return null;
    return this.storage.signGet(objectKey, this.env.MEDIA_PRESIGN_TTL_SECONDS);
  }

  /** 批量取每个样品的主图 URL（工具结果 / 找样候选需要真缩略图）。 */
  async primaryUrlsFor(sampleIds: string[]): Promise<Map<string, string>> {
    const rows = await this.listForSampleIds(sampleIds);
    const urls = new Map<string, string>();
    for (const [sampleId, images] of rows) {
      const primary = images.find((row) => row.isPrimary) ?? images[0];
      if (!primary) continue;
      const url = await this.urlFor(primary.objectKey);
      if (url) urls.set(sampleId, url);
    }
    return urls;
  }

  async attach(input: AttachSampleImageInput, ctx: KernelContext): Promise<SampleImageRow> {
    // 归属检查放在写之前：objectKey 里的 sampleId 来自客户端，不能靠 key 路径自证租户。
    const owned = await this.db
      .select({ id: samples.id })
      .from(samples)
      .where(and(eq(samples.id, input.sampleId), eq(samples.tenantId, this.tenantId)))
      .limit(1);
    if (owned.length === 0) {
      throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${input.sampleId}`, {
        resourceType: "sample",
        resourceId: input.sampleId,
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        // 不变量：有图就必须有且仅有一张主图。第一张图默认成为主图，
        // 否则移动端「拍照建样品」只 confirm 不 PATCH 时会留下无主图的样品。
        const existingPrimary = await tx
          .select({ id: sampleImages.id })
          .from(sampleImages)
          .where(
            and(
              eq(sampleImages.tenantId, this.tenantId),
              eq(sampleImages.sampleId, input.sampleId),
              eq(sampleImages.isPrimary, true),
            ),
          )
          .limit(1);
        const rows = await tx
          .insert(sampleImages)
          .values({
            tenantId: this.tenantId,
            sampleId: input.sampleId,
            objectKey: input.objectKey,
            variant: input.variant,
            isPrimary: input.isPrimary || existingPrimary.length === 0,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            width: input.width ?? null,
            height: input.height ?? null,
            sortOrder: input.sortOrder ?? 0,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new KernelError("KERNEL_REJECTED", "图片写入未返回记录", {
            reason: "INSERT_RETURNED_NO_ROW",
          });
        }
        await appendAudit(
          tx,
          ctx,
          {
            action: "SAMPLE_IMAGE_ADDED",
            entityType: "sample",
            entityId: input.sampleId,
            before: null,
            after: {
              imageId: row.id,
              variant: row.variant,
              isPrimary: row.isPrimary,
              mimeType: row.mimeType,
              byteSize: row.byteSize,
            },
          },
          this.tenantId,
        );
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const constraint = uniqueViolationConstraint(error) ?? "";
        if (constraint.includes("primary_per_sample")) {
          throw new KernelError("KERNEL_REJECTED", "该样品已有主图，请先取消原主图", {
            reason: "SAMPLE_PRIMARY_IMAGE_EXISTS",
          });
        }
        throw new KernelError("KERNEL_REJECTED", "这张图已挂到样品上", {
          reason: "SAMPLE_IMAGE_EXISTS",
        });
      }
      throw error;
    }
  }
}
