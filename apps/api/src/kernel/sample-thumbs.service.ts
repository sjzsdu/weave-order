import { sampleImages } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { ObjectStorage } from "../platform/storage";
import {
  DETAIL_THUMB_WIDTH,
  THUMB_WIDTHS,
  WALL_THUMB_WIDTH,
  renderThumbnail,
  thumbObjectKey,
} from "../platform/thumbnail";
import type { ThumbWidth } from "../platform/thumbnail";

export type SampleImageThumbRow = typeof sampleImages.$inferSelect;
export type ThumbStatus = "pending" | "ready" | "failed";
export type ThumbDeriveOutcome = "ready" | "unchanged" | "missing";

export interface ThumbDeriveFailure {
  imageId: string;
  sampleId: string;
  message: string;
}

export interface ThumbDeriveOptions {
  /** 强制重算（原图被重编码 / 换压缩参数时用）；默认已是 ready 就跳过，保证幂等。 */
  force?: boolean;
  /** 生成质量（webp）。默认 72。 */
  quality?: number;
}

/**
 * 样品缩略图的派生与落盘。
 *
 * 与 `ImageIndexService` 的分工：
 * - S4 的 512px 缩放是**送给模型的中间产物**，按需生成、不保证落盘；
 * - 这里是**持久化资源**：稳定 key、可缓存、可批量回填，图墙长期直接读取。
 *
 * 失败不静默：`thumb_status = failed` + `thumb_error` 落库，读模型带状态返回，
 * 客户端据此显示「缩略图失败」并回退原图，而不是假装有缩略图。
 */
export class SampleThumbService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly storage: ObjectStorage | null,
    private readonly options: { quality?: number } = {},
  ) {}

  get enabled(): boolean {
    return this.storage !== null;
  }

  private get quality(): number {
    return this.options.quality ?? 72;
  }

  async derive(imageId: string, options: ThumbDeriveOptions = {}): Promise<ThumbDeriveOutcome> {
    const rows = await this.db
      .select()
      .from(sampleImages)
      .where(and(eq(sampleImages.id, imageId), eq(sampleImages.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) return "missing";
    if (
      !options.force &&
      row.thumbStatus === "ready" &&
      row.thumb320Key !== null &&
      row.thumb640Key !== null
    ) {
      return "unchanged";
    }
    if (!this.storage) {
      throw new Error("对象存储未配置，无法派生缩略图（请配置 S3_* 或使用本地 MinIO）");
    }

    try {
      const object = await this.storage.get(row.objectKey);
      if (!object) throw new Error(`对象不存在，无法派生缩略图：${row.objectKey}`);
      if (object.bytes.length === 0) throw new Error(`对象为空，无法派生缩略图：${row.objectKey}`);

      const quality = options.quality ?? this.quality;
      const keys = new Map<ThumbWidth, string>();
      for (const width of THUMB_WIDTHS) {
        const key = thumbObjectKey(this.tenantId, row.sampleId, row.id, width);
        const bytes = await renderThumbnail(object.bytes, width, quality);
        await this.storage.put(key, bytes, "image/webp");
        keys.set(width, key);
      }

      await this.db
        .update(sampleImages)
        .set({
          thumb320Key: keys.get(WALL_THUMB_WIDTH) ?? null,
          thumb640Key: keys.get(DETAIL_THUMB_WIDTH) ?? null,
          thumbStatus: "ready",
          thumbError: null,
        })
        .where(and(eq(sampleImages.id, imageId), eq(sampleImages.tenantId, this.tenantId)));
      return "ready";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .update(sampleImages)
        .set({ thumbStatus: "failed", thumbError: message.slice(0, 255) })
        .where(and(eq(sampleImages.id, imageId), eq(sampleImages.tenantId, this.tenantId)));
      // 失败已落库；抛给调用方决定是否阻塞（confirm 选择不阻塞）。
      throw error;
    }
  }

  /** 补齐一个样品下的全部缺缩略图（建样品 / 改图组后调用，单张失败不影响其它）。 */
  async deriveForSample(
    sampleId: string,
    options: ThumbDeriveOptions = {},
  ): Promise<ThumbDeriveFailure[]> {
    const rows = await this.db
      .select({ imageId: sampleImages.id, sampleId: sampleImages.sampleId })
      .from(sampleImages)
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          eq(sampleImages.sampleId, sampleId),
          or(
            ne(sampleImages.thumbStatus, "ready"),
            isNull(sampleImages.thumb320Key),
            isNull(sampleImages.thumb640Key),
          ),
        ),
      )
      .orderBy(asc(sampleImages.sortOrder), asc(sampleImages.createdAt));
    const failures: ThumbDeriveFailure[] = [];
    for (const row of rows) {
      try {
        await this.derive(row.imageId, options);
      } catch (error) {
        failures.push({
          imageId: row.imageId,
          sampleId: row.sampleId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return failures;
  }

  /** 本租户待派生（pending / 上次失败 / key 缺失）的图片 id。 */
  async pendingImageIds(limit = 200): Promise<string[]> {
    const rows = await this.db
      .select({ id: sampleImages.id })
      .from(sampleImages)
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          or(
            ne(sampleImages.thumbStatus, "ready"),
            isNull(sampleImages.thumb320Key),
            isNull(sampleImages.thumb640Key),
          ),
        ),
      )
      .orderBy(asc(sampleImages.createdAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async pendingCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sampleImages)
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          or(
            ne(sampleImages.thumbStatus, "ready"),
            isNull(sampleImages.thumb320Key),
            isNull(sampleImages.thumb640Key),
          ),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /** 按状态分组的计数：CLI 报告与图墙健康检查用。 */
  async statusCounts(): Promise<Record<ThumbStatus, number>> {
    const rows = await this.db
      .select({ status: sampleImages.thumbStatus, count: sql<number>`count(*)::int` })
      .from(sampleImages)
      .where(eq(sampleImages.tenantId, this.tenantId))
      .groupBy(sampleImages.thumbStatus);
    const counts: Record<ThumbStatus, number> = { pending: 0, ready: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === "pending" || row.status === "ready" || row.status === "failed") {
        counts[row.status] = row.count;
      }
    }
    return counts;
  }
}
