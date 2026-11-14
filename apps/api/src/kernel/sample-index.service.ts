import { createHash } from "node:crypto";
import { sampleEmbeddings, sampleTextEmbeddings, samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { EmbeddingProvider } from "../platform/embedding";
import { escapeLikePattern } from "./like";
import { sampleEmbeddingText } from "./sample-embedding-text";

type SampleRow = typeof samples.$inferSelect;

/** 生成向量的文本输入（字段顺序固定，hash 才有意义）。 */
export type SampleTextSource = {
  code: string;
  name: string;
  composition: string | null;
  category?: string | null;
  weight: string | null;
};

/** 文本 sha256：样品改名 / 改成分 / 改克重都会变，索引据此重算。 */
export function sampleContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface PreparedSampleVector {
  text: string;
  contentHash: string;
  embedding: number[];
}

export interface ReindexFailure {
  sampleId: string;
  code: string;
  message: string;
}

export interface ReindexResult {
  total: number;
  indexed: number;
  skipped: number;
  failures: ReindexFailure[];
}

/** pgvector 的向量参数：JSON 数组文本，交给 PG 隐式转成 vector。 */
function vectorLiteral(vector: number[]): string {
  return JSON.stringify(vector);
}

export interface SemanticMatch {
  sample: SampleRow;
  score: number;
}

/**
 * 样品文本向量索引的维护与检索。
 *
 * - 写入时机：单条 create/update 在同一请求内同步（失败即请求失败，不写半条索引）；
 *   批量导入在提交后走 `reindexTenant`，失败不阻塞导入但要记审计。
 * - `contentHash` 未变就不重复调用模型（省钱，也让「改名才重算」可验证）。
 * - 检索用 pgvector `<=>` + HNSW；分数 = 1 - cosine 距离，即**原始 cosine 相似度**，
 *   不做任何归一化或映射。
 */
export class SampleIndexService {
  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly tenantId: string,
  ) {}

  get model(): string {
    return this.embedder.name;
  }

  get semantic(): boolean {
    return this.embedder.semantic;
  }

  get dimension(): number {
    return this.embedder.dimension;
  }

  /** 计算一条样品的向量（事务外调用；模型超时/5xx 直接抛错）。 */
  async prepare(sample: SampleTextSource): Promise<PreparedSampleVector> {
    const text = sampleEmbeddingText(sample);
    const [embedding] = await this.embedder.embedTexts([text]);
    if (!embedding) throw new Error("embedding provider 未返回向量");
    if (embedding.length !== this.embedder.dimension) {
      throw new Error(
        `embedding 维度不一致：provider=${this.embedder.name} 期望 ${this.embedder.dimension}，实际 ${embedding.length}`,
      );
    }
    return { text, contentHash: sampleContentHash(text), embedding };
  }

  /**
   * 事务内 upsert：contentHash 相同则跳过（不重复写、不刷新 createdAt）。
   *
   * `local-stub`（`semantic=false`）没有 contentHash 语义，写入旧的 `real[]` 表：
   * 那条路径只服务本地演示/测试的以图搜图兼容，不参与真实语义检索。
   */
  async writeWithin(
    tx: Db | Tx,
    sampleId: string,
    prepared: PreparedSampleVector,
  ): Promise<"inserted" | "updated" | "skipped"> {
    if (!this.semantic) {
      const legacy = await tx
        .select({ id: sampleEmbeddings.id })
        .from(sampleEmbeddings)
        .where(
          and(
            eq(sampleEmbeddings.sampleId, sampleId),
            eq(sampleEmbeddings.model, this.model),
            eq(sampleEmbeddings.tenantId, this.tenantId),
          ),
        )
        .limit(1);
      if (legacy[0]) return "skipped";
      await tx
        .insert(sampleEmbeddings)
        .values({
          tenantId: this.tenantId,
          sampleId,
          model: this.model,
          dimension: prepared.embedding.length,
          embedding: prepared.embedding,
        })
        .onConflictDoNothing();
      return "inserted";
    }

    const existing = await tx
      .select({ contentHash: sampleTextEmbeddings.contentHash })
      .from(sampleTextEmbeddings)
      .where(
        and(
          eq(sampleTextEmbeddings.sampleId, sampleId),
          eq(sampleTextEmbeddings.model, this.model),
          eq(sampleTextEmbeddings.tenantId, this.tenantId),
        ),
      )
      .limit(1);
    const current = existing[0];
    if (current?.contentHash === prepared.contentHash) return "skipped";

    await tx
      .insert(sampleTextEmbeddings)
      .values({
        tenantId: this.tenantId,
        sampleId,
        model: this.model,
        dimension: prepared.embedding.length,
        embedding: prepared.embedding,
        contentHash: prepared.contentHash,
      })
      .onConflictDoUpdate({
        target: [sampleTextEmbeddings.sampleId, sampleTextEmbeddings.model],
        set: {
          dimension: prepared.embedding.length,
          embedding: prepared.embedding,
          contentHash: prepared.contentHash,
          createdAt: sql`now()`,
        },
      });
    return current ? "updated" : "inserted";
  }

  /** 单条补齐 / 重算。样品不存在返回 `missing`。 */
  async ensureIndexedSample(sampleId: string): Promise<"indexed" | "unchanged" | "missing"> {
    const rows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.id, sampleId), eq(samples.tenantId, this.tenantId)))
      .limit(1);
    const sample = rows[0];
    if (!sample) return "missing";

    const text = sampleEmbeddingText(sample);
    const contentHash = sampleContentHash(text);
    if (!this.semantic) {
      const legacy = await this.db
        .select({ id: sampleEmbeddings.id })
        .from(sampleEmbeddings)
        .where(
          and(
            eq(sampleEmbeddings.sampleId, sampleId),
            eq(sampleEmbeddings.model, this.model),
            eq(sampleEmbeddings.tenantId, this.tenantId),
          ),
        )
        .limit(1);
      if (legacy[0]) return "unchanged";
      await this.writeWithin(this.db, sampleId, await this.prepare(sample));
      return "indexed";
    }
    const existing = await this.db
      .select({ contentHash: sampleTextEmbeddings.contentHash })
      .from(sampleTextEmbeddings)
      .where(
        and(
          eq(sampleTextEmbeddings.sampleId, sampleId),
          eq(sampleTextEmbeddings.model, this.model),
          eq(sampleTextEmbeddings.tenantId, this.tenantId),
        ),
      )
      .limit(1);
    if (existing[0]?.contentHash === contentHash) return "unchanged";

    const prepared = await this.prepare(sample);
    await this.writeWithin(this.db, sampleId, prepared);
    return "indexed";
  }

  /**
   * 廉价缺失探测：反连接判断是否还有样品没有当前模型的索引行。
   *
   * 不做全量 sha256（那是 reindex 的活），读路径每次搜索只付这一条 EXISTS 的成本。
   */
  async hasMissingIndex(): Promise<boolean> {
    const join = this.semantic
      ? and(
          eq(sampleTextEmbeddings.sampleId, samples.id),
          eq(sampleTextEmbeddings.model, this.model),
          eq(sampleTextEmbeddings.tenantId, this.tenantId),
        )
      : and(
          eq(sampleEmbeddings.sampleId, samples.id),
          eq(sampleEmbeddings.model, this.model),
          eq(sampleEmbeddings.tenantId, this.tenantId),
        );
    const rows = this.semantic
      ? await this.db
          .select({ id: samples.id })
          .from(samples)
          .leftJoin(sampleTextEmbeddings, join)
          .where(and(eq(samples.tenantId, this.tenantId), isNull(sampleTextEmbeddings.id)))
          .limit(1)
      : await this.db
          .select({ id: samples.id })
          .from(samples)
          .leftJoin(sampleEmbeddings, join)
          .where(and(eq(samples.tenantId, this.tenantId), isNull(sampleEmbeddings.id)))
          .limit(1);
    return rows.length > 0;
  }

  /**
   * 全租户补齐 / 重算（后台任务与 CLI 用）。
   *
   * 每 10 条一批调用模型（provider 内部切片），单批失败只记入 `failures`，
   * 不影响其它批；调用方决定是否把失败写进审计。
   */
  async reindexTenant(batchSize = 20): Promise<ReindexResult> {
    const all = await this.db.select().from(samples).where(eq(samples.tenantId, this.tenantId));
    return this.reindexRows(all, batchSize);
  }

  /** 只重算指定样品（导入后补新增行，避免全租户扫描）。 */
  async reindexSamples(sampleIds: string[]): Promise<ReindexResult> {
    if (sampleIds.length === 0) return { total: 0, indexed: 0, skipped: 0, failures: [] };
    const rows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), inArray(samples.id, sampleIds)));
    return this.reindexRows(rows, 10);
  }

  /** 共用的批量重算实现：先按 contentHash 筛出待算行，再按批调用模型。 */
  private async reindexRows(all: SampleRow[], batchSize: number): Promise<ReindexResult> {
    const indexedRows = this.semantic
      ? await this.db
          .select({
            sampleId: sampleTextEmbeddings.sampleId,
            contentHash: sampleTextEmbeddings.contentHash,
          })
          .from(sampleTextEmbeddings)
          .where(
            and(
              eq(sampleTextEmbeddings.tenantId, this.tenantId),
              eq(sampleTextEmbeddings.model, this.model),
            ),
          )
      : (
          await this.db
            .select({ sampleId: sampleEmbeddings.sampleId })
            .from(sampleEmbeddings)
            .where(
              and(
                eq(sampleEmbeddings.tenantId, this.tenantId),
                eq(sampleEmbeddings.model, this.model),
              ),
            )
        ).map((row) => ({ ...row, contentHash: null as string | null }));
    const indexed = new Map(indexedRows.map((row) => [row.sampleId, row.contentHash]));

    const pending: { sample: SampleRow; text: string; contentHash: string }[] = [];
    let skipped = 0;
    for (const sample of all) {
      const text = sampleEmbeddingText(sample);
      const contentHash = sampleContentHash(text);
      const known = indexed.get(sample.id);
      if (this.semantic ? known === contentHash : known !== undefined) {
        skipped += 1;
        continue;
      }
      pending.push({ sample, text, contentHash });
    }

    const failures: ReindexFailure[] = [];
    let done = 0;
    const chunkSize = Math.max(1, Math.min(batchSize, 10));
    for (let offset = 0; offset < pending.length; offset += chunkSize) {
      const chunk = pending.slice(offset, offset + chunkSize);
      let vectors: number[][];
      try {
        vectors = await this.embedder.embedTexts(chunk.map((item) => item.text));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const item of chunk) {
          failures.push({ sampleId: item.sample.id, code: item.sample.code, message });
        }
        continue;
      }
      for (const [index, item] of chunk.entries()) {
        const embedding = vectors[index];
        if (!embedding) {
          failures.push({
            sampleId: item.sample.id,
            code: item.sample.code,
            message: "provider 返回条数不足",
          });
          continue;
        }
        try {
          await this.writeWithin(this.db, item.sample.id, {
            text: item.text,
            contentHash: item.contentHash,
            embedding,
          });
          done += 1;
        } catch (error) {
          failures.push({
            sampleId: item.sample.id,
            code: item.sample.code,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return { total: all.length, indexed: done, skipped, failures };
  }

  /**
   * 向量检索：按 cosine 距离升序取 topN，`score` 是原始 cosine 相似度。
   * 低于 `minScore` 的行不返回（负相似度的「噪声」不会被伪装成正分）。
   */
  async searchByVector(
    vector: number[],
    limit: number,
    minScore: number,
    composition?: string,
  ): Promise<SemanticMatch[]> {
    // 显式 ::vector：不依赖驱动把 text 参数隐式转成 vector（prepared statement 类型化后会失效）。
    const distance = sql`${sampleTextEmbeddings.embedding} <=> ${vectorLiteral(vector)}::vector`;
    const conditions = [
      eq(sampleTextEmbeddings.tenantId, this.tenantId),
      eq(sampleTextEmbeddings.model, this.model),
      sql`1 - (${distance}) >= ${minScore}`,
    ];
    if (composition) {
      // 与主分支同一套字面量转义：`%` / `_` 不能被当成通配符。
      const pattern = `%${escapeLikePattern(composition)}%`;
      conditions.push(sql`${samples.composition} ILIKE ${pattern} ESCAPE '\\'`);
    }
    const rows = await this.db
      .select({
        sample: samples,
        distance: sql<number>`${distance}`,
      })
      .from(sampleTextEmbeddings)
      .innerJoin(samples, eq(sampleTextEmbeddings.sampleId, samples.id))
      .where(and(...conditions))
      .orderBy(distance)
      .limit(limit);
    return rows.map((row) => ({ sample: row.sample, score: 1 - Number(row.distance) }));
  }
}
