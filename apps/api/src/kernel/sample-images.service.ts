import { sampleImages, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { SampleImageVariant } from "@weave-order/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation, uniqueViolationConstraint } from "./errors";

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
  ) {}

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
      .orderBy(asc(sampleImages.sortOrder), asc(sampleImages.createdAt));
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
        const rows = await tx
          .insert(sampleImages)
          .values({
            tenantId: this.tenantId,
            sampleId: input.sampleId,
            objectKey: input.objectKey,
            variant: input.variant,
            isPrimary: input.isPrimary,
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
