import { sampleEmbeddings, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { T002SearchFabricBySpecInput } from "@weave-order/schema";
import type { SpecMatch, T002SearchFabricBySpecData } from "@weave-order/schema";
import type { EmbeddingProvider } from "../platform/embedding";
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { mapSample } from "./samples.service";
import { sampleEmbeddingText } from "./sample-embedding-text";

type SampleRow = typeof samples.$inferSelect;

/**
 * 把用户输入里的 LIKE 元字符转义成字面量。
 * `%` / `_` 是通配符，`\` 是转义符本身；三层顺序不能反，否则会双重转义。
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * 字面量 ILIKE：转义后的模式 + 显式 ESCAPE '\'。
 * 与 `matchedOn` 的 `String.includes` 复核语义一致：都按字面字符匹配。
 */
function ilikeLiteral(column: AnyColumn, pattern: string): SQL {
  return sql`${column} ILIKE ${pattern} ESCAPE '\\'`;
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 找样内核服务（只读）。
 *
 * - 以图搜图：图像向量与样品文本向量做 cosine，排序后取 topK；
 * - 参数匹配：确定性的 SQL 匹配 + 命中字段说明，不编造相关性。
 * 搜索不写业务表；缺索引时会补齐 `sample_embeddings`（幂等）。
 */
export class SearchService {
  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly tenantId: string,
  ) {}

  /** 给尚未建索引的样品补向量，返回本次补齐的数量。 */
  async ensureIndexed(): Promise<number> {
    const indexedRows = await this.db
      .select({ sampleId: sampleEmbeddings.sampleId })
      .from(sampleEmbeddings)
      .where(
        and(
          eq(sampleEmbeddings.model, this.embedder.name),
          eq(sampleEmbeddings.tenantId, this.tenantId),
        ),
      );
    const indexed = new Set(indexedRows.map((row) => row.sampleId));
    const all = await this.db.select().from(samples).where(eq(samples.tenantId, this.tenantId));
    const missing = all.filter((sample) => !indexed.has(sample.id));

    for (const sample of missing) {
      const embedding = await this.embedder.embedText(sampleEmbeddingText(sample));
      await this.db
        .insert(sampleEmbeddings)
        .values({
          tenantId: this.tenantId,
          sampleId: sample.id,
          model: this.embedder.name,
          dimension: this.embedder.dimension,
          embedding,
        })
        .onConflictDoNothing();
    }
    return missing.length;
  }

  async searchByImage(
    image: { mimeType: string; base64: string },
    topK: number,
    minSimilarity: number,
  ): Promise<{
    embeddingModel: string;
    dimension: number;
    matches: { sample: ReturnType<typeof mapSample>; score: number }[];
  }> {
    await this.ensureIndexed();
    const queryVector = await this.embedder.embedImage(image);
    const rows = await this.db
      .select({ embedding: sampleEmbeddings.embedding, sample: samples })
      .from(sampleEmbeddings)
      .innerJoin(samples, eq(sampleEmbeddings.sampleId, samples.id))
      .where(
        and(
          eq(sampleEmbeddings.model, this.embedder.name),
          eq(sampleEmbeddings.tenantId, this.tenantId),
        ),
      );

    const scored = rows
      .map((row) => ({
        sample: mapSample(row.sample),
        // cosine ∈ [-1,1] 映射到 [0,1]，与契约一致
        score: Math.max(0, Math.min(1, (cosine(queryVector, row.embedding) + 1) / 2)),
      }))
      .filter((match) => match.score >= minSimilarity)
      .sort((a, b) => b.score - a.score || a.sample.code.localeCompare(b.sample.code))
      .slice(0, topK);

    return {
      embeddingModel: this.embedder.name,
      dimension: this.embedder.dimension,
      matches: scored,
    };
  }

  async searchBySpec(input: unknown): Promise<T002SearchFabricBySpecData> {
    const parsed = T002SearchFabricBySpecInput.parse(input);
    const term = `%${escapeLikePattern(parsed.query)}%`;
    const conditions = [
      ilikeLiteral(samples.code, term),
      ilikeLiteral(samples.name, term),
      ilikeLiteral(samples.composition, term),
      ilikeLiteral(samples.weight, term),
    ];
    const where =
      parsed.composition === undefined
        ? or(...conditions)
        : and(
            or(...conditions),
            ilikeLiteral(samples.composition, `%${escapeLikePattern(parsed.composition)}%`),
          );

    const rows = await this.db
      .select()
      .from(samples)
      .where(and(where, eq(samples.tenantId, this.tenantId)))
      .orderBy(desc(samples.createdAt))
      .limit(parsed.limit);

    const matches: SpecMatch[] = rows.map((row) => {
      const q = parsed.query.toLowerCase();
      const matchedOn: SpecMatch["matchedOn"] = [];
      if (row.code.toLowerCase().includes(q)) matchedOn.push("code");
      if (row.name.toLowerCase().includes(q)) matchedOn.push("name");
      if ((row.composition ?? "").toLowerCase().includes(q)) matchedOn.push("composition");
      if ((row.weight ?? "").toLowerCase().includes(q)) matchedOn.push("weight");
      return {
        sample: mapSample(row),
        score: matchedOn.length / 4,
        matchedOn,
      };
    });

    // 不变式：SQL 字面量匹配与 matchedOn 复核必须一致，返回行不得「零命中」。
    if (matches.some((match) => match.matchedOn.length === 0)) {
      throw new Error("searchBySpec invariant violated: returned row has empty matchedOn");
    }

    // 命中字段越多越靠前；同分按创建时间（已是倒序）。
    matches.sort((a, b) => b.score - a.score);
    return { matches };
  }

  /** 只读目录，给前端页面用。 */
  async listSamples(limit = 50): Promise<ReturnType<typeof mapSample>[]> {
    const rows = await this.db
      .select()
      .from(samples)
      .where(eq(samples.tenantId, this.tenantId))
      .orderBy(desc(samples.createdAt))
      .limit(limit);
    return rows.map((row: SampleRow) => mapSample(row));
  }
}
