import { sampleImageEmbeddings, sampleImages, samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ImageEmbeddingProvider } from "../platform/embedding";
import type { ObjectStorage } from "../platform/storage";

type SampleRow = typeof samples.$inferSelect;

/** pgvector 的向量参数：JSON 数组文本，显式 `::vector` 转换（与 S3 同一套写法）。 */
function vectorLiteral(vector: number[]): string {
  return JSON.stringify(vector);
}

/** 索引名前缀 + 模型名，长度截到 PG 的 63 字节上限。 */
export function imageHnswIndexName(model: string): string {
  return `sample_image_embeddings_hnsw_${model.replace(/[^a-zA-Z0-9]+/g, "_")}`.slice(0, 63);
}

export type ImageIndexOutcome = "indexed" | "unchanged" | "missing";

export interface ImageReindexFailure {
  imageId: string;
  sampleId: string;
  message: string;
}

export interface ImageReindexResult {
  total: number;
  indexed: number;
  skipped: number;
  failures: ImageReindexFailure[];
}

export interface ImageVectorMatch {
  sample: SampleRow;
  imageId: string;
  objectKey: string;
  /** 原始 cosine 相似度（1 - pgvector 距离），不做任何归一化。 */
  score: number;
}

/**
 * 样品图像向量的索引与检索。
 *
 * 与 S3 的文本索引刻意分开：不同的模型、不同的空间、不同的阈值。
 * 唯一相同的约定是「失败必须显式」，绝不把没索引的图当成「搜不到」。
 */
export class ImageIndexService {
  constructor(
    private readonly db: Db,
    private readonly embedder: ImageEmbeddingProvider,
    private readonly tenantId: string,
    private readonly storage: ObjectStorage | null,
  ) {}

  get model(): string {
    return this.embedder.name;
  }

  get dimension(): number {
    return this.embedder.dimension;
  }

  get semantic(): boolean {
    return this.embedder.semantic;
  }

  get enabled(): boolean {
    return this.storage !== null;
  }

  /**
   * 给单张图算向量并落库。
   *
   * 失败会把 `sample_images.index_status` 置为 `failed` 并记录原因，然后**继续抛错**：
   * 调用方（confirm / 建立样品）可以选择不阻塞主流程，但「失败」这件事必须留下痕迹，
   * 图墙才能显示「索引失败」而不是「没搜到」。
   */
  async indexImage(imageId: string): Promise<ImageIndexOutcome> {
    const rows = await this.db
      .select({
        imageId: sampleImages.id,
        sampleId: sampleImages.sampleId,
        objectKey: sampleImages.objectKey,
        mimeType: sampleImages.mimeType,
      })
      .from(sampleImages)
      .where(and(eq(sampleImages.id, imageId), eq(sampleImages.tenantId, this.tenantId)))
      .limit(1);
    const image = rows[0];
    if (!image) return "missing";

    const existing = await this.db
      .select({ id: sampleImageEmbeddings.id })
      .from(sampleImageEmbeddings)
      .where(
        and(
          eq(sampleImageEmbeddings.imageId, imageId),
          eq(sampleImageEmbeddings.model, this.model),
          eq(sampleImageEmbeddings.tenantId, this.tenantId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      // 已经算过：只修状态（例如上次写完向量但状态没更新就被打断）。
      await this.markReady(imageId);
      return "unchanged";
    }

    try {
      const vector = await this.embedStored(image.objectKey, image.mimeType);
      await this.writeVector(image.sampleId, imageId, vector);
      await this.markReady(imageId);
      return "indexed";
    } catch (error) {
      await this.markFailed(imageId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** 补齐一个样品下所有缺失的图（建样品/改图组之后调用，失败只影响单张）。 */
  async ensureSampleIndexed(sampleId: string): Promise<ImageReindexFailure[]> {
    const rows = await this.db
      .select({ imageId: sampleImages.id })
      .from(sampleImages)
      .leftJoin(
        sampleImageEmbeddings,
        and(
          eq(sampleImageEmbeddings.imageId, sampleImages.id),
          eq(sampleImageEmbeddings.model, this.model),
        ),
      )
      .where(
        and(
          eq(sampleImages.tenantId, this.tenantId),
          eq(sampleImages.sampleId, sampleId),
          isNull(sampleImageEmbeddings.id),
        ),
      );
    const failures: ImageReindexFailure[] = [];
    for (const row of rows) {
      try {
        await this.indexImage(row.imageId);
      } catch (error) {
        failures.push({
          imageId: row.imageId,
          sampleId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return failures;
  }

  /** 廉价缺失探测：还有没有图没有当前模型的向量（读路径兜底用，不做全量扫描）。 */
  async hasMissingImages(): Promise<boolean> {
    const rows = await this.db
      .select({ id: sampleImages.id })
      .from(sampleImages)
      .leftJoin(
        sampleImageEmbeddings,
        and(
          eq(sampleImageEmbeddings.imageId, sampleImages.id),
          eq(sampleImageEmbeddings.model, this.model),
        ),
      )
      .where(and(eq(sampleImages.tenantId, this.tenantId), isNull(sampleImageEmbeddings.id)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * 还有多少张图没有当前模型的向量。
   *
   * 找样响应里带上这个数字：图墙/找样页要能说「还有 N 张图在检索中」，
   * 而不是把「没索引」表现成「没搜到」。
   */
  async pendingCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sampleImages)
      .leftJoin(
        sampleImageEmbeddings,
        and(
          eq(sampleImageEmbeddings.imageId, sampleImages.id),
          eq(sampleImageEmbeddings.model, this.model),
        ),
      )
      .where(and(eq(sampleImages.tenantId, this.tenantId), isNull(sampleImageEmbeddings.id)));
    return rows[0]?.count ?? 0;
  }

  /**
   * 全租户补齐 / 重算（CLI 与后台任务用）。
   *
   * 一次请求最多送 provider 允许的张数（通义 10 张），单批失败只记入 failures，
   * 不阻塞其它批。1 万张图的成本约 1 元，耗时几分钟 —— 换模型时这就是全部代价。
   */
  async reindexTenant(batchSize?: number): Promise<ImageReindexResult> {
    const pending = await this.db
      .select({
        imageId: sampleImages.id,
        sampleId: sampleImages.sampleId,
        objectKey: sampleImages.objectKey,
        mimeType: sampleImages.mimeType,
      })
      .from(sampleImages)
      .leftJoin(
        sampleImageEmbeddings,
        and(
          eq(sampleImageEmbeddings.imageId, sampleImages.id),
          eq(sampleImageEmbeddings.model, this.model),
        ),
      )
      .where(and(eq(sampleImages.tenantId, this.tenantId), isNull(sampleImageEmbeddings.id)));

    const total = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sampleImages)
      .where(eq(sampleImages.tenantId, this.tenantId));

    const chunk = Math.max(1, Math.min(batchSize ?? this.embedder.maxImagesPerRequest, this.embedder.maxImagesPerRequest));
    const failures: ImageReindexFailure[] = [];
    let indexed = 0;

    for (let offset = 0; offset < pending.length; offset += chunk) {
      const slice = pending.slice(offset, offset + chunk);
      const usable: { row: (typeof slice)[number]; base64: string; mimeType: string }[] = [];
      for (const row of slice) {
        try {
          const bytes = await this.readObject(row.objectKey);
          usable.push({ row, base64: bytes.base64, mimeType: bytes.mimeType });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ imageId: row.imageId, sampleId: row.sampleId, message });
          await this.markFailed(row.imageId, message);
        }
      }
      if (usable.length === 0) continue;

      let vectors: number[][];
      try {
        vectors = await this.embedder.embedImages(
          usable.map((item) => ({ mimeType: item.mimeType, base64: item.base64 })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const item of usable) {
          failures.push({ imageId: item.row.imageId, sampleId: item.row.sampleId, message });
          await this.markFailed(item.row.imageId, message);
        }
        continue;
      }

      for (const [index, item] of usable.entries()) {
        const vector = vectors[index];
        if (!vector) {
          const message = "provider 返回条数不足";
          failures.push({ imageId: item.row.imageId, sampleId: item.row.sampleId, message });
          await this.markFailed(item.row.imageId, message);
          continue;
        }
        try {
          await this.writeVector(item.row.sampleId, item.row.imageId, vector);
          await this.markReady(item.row.imageId);
          indexed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ imageId: item.row.imageId, sampleId: item.row.sampleId, message });
          await this.markFailed(item.row.imageId, message);
        }
      }
    }

    return {
      total: total[0]?.count ?? 0,
      indexed,
      skipped: Math.max(0, (total[0]?.count ?? 0) - pending.length),
      failures,
    };
  }

  /**
   * 向量检索：按 cosine 距离升序取 topN。
   *
   * - 显式 `model` 条件 + `::vector(N)` 表达式，才能命中该模型的 partial HNSW 索引；
   * - `minScore` 是原始 cosine 阈值，低于它的行不进结果（宁缺毋滥）。
   */
  async searchByVector(vector: number[], limit: number, minScore: number): Promise<ImageVectorMatch[]> {
    const dim = sql.raw(String(this.dimension));
    const distance = sql`(${sampleImageEmbeddings.embedding}::vector(${dim})) <=> ${vectorLiteral(vector)}::vector`;
    const rows = await this.db
      .select({
        sample: samples,
        imageId: sampleImageEmbeddings.imageId,
        objectKey: sampleImages.objectKey,
        distance: sql<number>`${distance}`,
      })
      .from(sampleImageEmbeddings)
      .innerJoin(sampleImages, eq(sampleImages.id, sampleImageEmbeddings.imageId))
      .innerJoin(samples, eq(samples.id, sampleImageEmbeddings.sampleId))
      .where(
        and(
          eq(sampleImageEmbeddings.tenantId, this.tenantId),
          eq(sampleImageEmbeddings.model, this.model),
          sql`1 - (${distance}) >= ${minScore}`,
        ),
      )
      .orderBy(distance)
      .limit(limit);
    return rows.map((row) => ({
      sample: row.sample,
      imageId: row.imageId,
      objectKey: row.objectKey,
      score: 1 - Number(row.distance),
    }));
  }

  /**
   * 给已有模型建 partial HNSW 索引（切换 provider 时跑一次）。
   *
   * 索引是「每模型一条」的表达式索引：列不定维，靠 `::vector(N)` 固定维度。
   * 幂等：已存在同名索引直接返回名称。
   */
  async ensureHnswIndex(): Promise<string> {
    const name = imageHnswIndexName(this.model);
    const dim = Math.max(1, Math.round(this.dimension));
    await this.db.execute(sql.raw(
      `CREATE INDEX IF NOT EXISTS "${name}" ON "sample_image_embeddings" ` +
        `USING hnsw ((embedding::vector(${dim})) vector_cosine_ops) ` +
        `WITH (m=16, ef_construction=64) WHERE model = '${this.model.replace(/'/g, "''")}'`,
    ));
    return name;
  }

  /** 事务内写向量（供需要与业务写同事务的调用方使用）。 */
  async writeVectorWithin(tx: Db | Tx, sampleId: string, imageId: string, vector: number[]): Promise<void> {
    await tx
      .insert(sampleImageEmbeddings)
      .values({
        tenantId: this.tenantId,
        sampleId,
        imageId,
        model: this.model,
        dimension: vector.length,
        embedding: vector,
      })
      .onConflictDoUpdate({
        target: [sampleImageEmbeddings.imageId, sampleImageEmbeddings.model],
        set: {
          dimension: vector.length,
          embedding: vector,
          createdAt: sql`now()`,
        },
      });
  }

  private async writeVector(sampleId: string, imageId: string, vector: number[]): Promise<void> {
    if (vector.length !== this.dimension) {
      throw new Error(
        `图像向量维度不一致：provider=${this.model} 期望 ${this.dimension}，实际 ${vector.length}；` +
          "换模型时请同步改 IMAGE_EMBEDDING_DIMENSION 并重建索引",
      );
    }
    await this.writeVectorWithin(this.db, sampleId, imageId, vector);
  }

  private async embedStored(objectKey: string, mimeType: string): Promise<number[]> {
    const { base64 } = await this.readObject(objectKey, mimeType);
    const [vector] = await this.embedder.embedImages([{ mimeType, base64 }]);
    if (!vector) throw new Error("图像 embedding provider 未返回向量");
    return vector;
  }

  private async readObject(
    objectKey: string,
    fallbackMimeType?: string,
  ): Promise<{ base64: string; mimeType: string }> {
    if (!this.storage) {
      throw new Error("对象存储未配置，无法读取样品图片做索引（请配置 S3_* 或使用 local-stub 演示模式）");
    }
    const object = await this.storage.get(objectKey);
    if (!object) throw new Error(`对象不存在，无法索引：${objectKey}`);
    if (object.bytes.length === 0) throw new Error(`对象为空，无法索引：${objectKey}`);
    const mimeType = object.contentType?.startsWith("image/")
      ? object.contentType.split(";")[0]!.trim()
      : (fallbackMimeType ?? "image/jpeg");
    return { base64: object.bytes.toString("base64"), mimeType };
  }

  private async markReady(imageId: string): Promise<void> {
    await this.db
      .update(sampleImages)
      .set({ indexStatus: "ready", indexError: null })
      .where(and(eq(sampleImages.id, imageId), eq(sampleImages.tenantId, this.tenantId)));
  }

  private async markFailed(imageId: string, message: string): Promise<void> {
    await this.db
      .update(sampleImages)
      .set({ indexStatus: "failed", indexError: message.slice(0, 255) })
      .where(and(eq(sampleImages.id, imageId), eq(sampleImages.tenantId, this.tenantId)));
  }
}
