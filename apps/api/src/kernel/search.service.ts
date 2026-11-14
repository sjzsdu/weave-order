import { sampleEmbeddings, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { T002SearchFabricBySpecInput } from "@weave-order/schema";
import type { FabricSample, SpecMatch, T002SearchFabricBySpecData } from "@weave-order/schema";
import type { EmbeddingProvider } from "../platform/embedding";
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { KernelContext } from "./audit";
import { mapSample, presentSample } from "./samples.service";
import { sampleEmbeddingText } from "./sample-embedding-text";
import { SampleIndexService } from "./sample-index.service";
import { escapeLikePattern } from "./like";
import type { SampleImageService } from "./sample-images.service";

type SampleRow = typeof samples.$inferSelect;

/**
 * 语义分支的默认最低 cosine 相似度。
 * 低于阈值的行直接不返回：宁缺毋滥，不用「负相似度映射到 0」来凑数。
 */
export const DEFAULT_SEMANTIC_MIN_SCORE = 0.5;

/**
 * 是否同时跑向量检索。
 *
 * - 只有真实语义模型才启用（local-stub 是哈希，跑出来的分数没有意义）；
 * - 查询足够长 / 含空格 / 含英文时才启用：短中文关键词（"涤纶"）用 ILIKE 更准也更便宜。
 */
export function shouldUseSemanticSearch(
  query: string,
  embedder: Pick<EmbeddingProvider, "semantic">,
): boolean {
  if (!embedder.semantic) return false;
  const trimmed = query.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length >= 8) return true;
  return /\s/.test(trimmed) || /[a-zA-Z]/.test(trimmed);
}

// 兼容既有 import 路径（search-escape 测试与其它模块从这里取）。
export { escapeLikePattern } from "./like";

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
 * - 以图搜图（T-001）：沿用旧 `sample_embeddings`（`real[]`）的兼容路径，
 *   **只在 local-stub 下维护**；真实语义模型不参与图像检索（S4 用多模态模型重做）。
 * - 参数匹配（T-002）：ILIKE 字面量匹配 + 语义向量补足。ILIKE 命中排前，
 *   语义命中标 `matchedOn: ["semantic"]`，分数是原始 cosine，不做归一化。
 */
export class SearchService {
  private readonly index: SampleIndexService;

  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly tenantId: string,
    private readonly sampleImages?: SampleImageService,
    private readonly semanticMinScore = DEFAULT_SEMANTIC_MIN_SCORE,
  ) {
    this.index = new SampleIndexService(db, embedder, tenantId);
  }

  /** 给候选样品补主图 URL，前端 `SampleTile` 才有真缩略图。 */
  private async primaryUrls(samples: FabricSample[]): Promise<Map<string, string>> {
    if (!this.sampleImages || samples.length === 0) return new Map();
    return this.sampleImages.primaryUrlsFor(samples.map((sample) => sample.id));
  }

  /**
   * 补齐样品索引，返回本次新写入的条数。
   *
   * 读路径只做**廉价缺失探测**（反连接是否存在没有索引行的样品），不再每次搜索
   * 全表 sha256。contentHash 漂移由写路径（create/update 同事务重算）与 CLI
   * `reindex:samples` 负责，因此这里仅当确实有“漏网”样品时才触发一次批量重算。
   */
  async ensureIndexed(): Promise<number> {
    if (this.embedder.semantic) {
      if (!(await this.index.hasMissingIndex())) return 0;
      const result = await this.index.reindexTenant();
      return result.indexed;
    }
    return this.ensureLegacyIndexed();
  }

  private async ensureLegacyIndexed(): Promise<number> {
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

    const images = await this.primaryUrls(scored.map((match) => match.sample));
    return {
      embeddingModel: this.embedder.name,
      dimension: this.embedder.dimension,
      matches: scored.map((match) => ({
        ...match,
        sample: { ...match.sample, primaryImageUrl: images.get(match.sample.id) ?? null },
      })),
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

    // 语义补足：ILIKE 命中的排前，向量只补未命中的样品，不重排已有结果。
    if (shouldUseSemanticSearch(parsed.query, this.embedder)) {
      await this.ensureIndexed();
      const queryVector = await this.embedder.embedText(parsed.query);
      const semanticMatches = await this.index.searchByVector(
        queryVector,
        parsed.limit,
        this.semanticMinScore,
        parsed.composition,
      );
      const seen = new Set(matches.map((match) => match.sample.id));
      for (const match of semanticMatches) {
        if (matches.length >= parsed.limit) break;
        if (seen.has(match.sample.id)) continue;
        seen.add(match.sample.id);
        matches.push({
          sample: mapSample(match.sample),
          // 仅防御契约（score 必须 0..1）；不是归一化：minScore 已挡住负相似度，数值就是原始 cosine。
          score: Math.max(0, Math.min(1, match.score)),
          matchedOn: ["semantic"],
        });
      }
    }

    const images = await this.primaryUrls(matches.map((match) => match.sample));
    return {
      matches: matches.map((match) => ({
        ...match,
        sample: { ...match.sample, primaryImageUrl: images.get(match.sample.id) ?? null },
      })),
    };
  }

  /**
   * 只读目录，给前端页面用。
   * 样品库是全租户共享目录（无归属人字段），因此不按 dataScope 过滤；
   * 但成本底线属于敏感字段，按角色裁剪（sales 不可见）。
   */
  async listSamples(limit = 50, ctx?: KernelContext): Promise<FabricSample[]> {
    const rows = await this.db
      .select()
      .from(samples)
      .where(eq(samples.tenantId, this.tenantId))
      .orderBy(desc(samples.createdAt))
      .limit(limit);
    const mapped = rows.map((row: SampleRow) => presentSample(row, ctx?.actor.role));
    const images = await this.primaryUrls(mapped);
    return mapped.map((sample) => ({
      ...sample,
      primaryImageUrl: images.get(sample.id) ?? null,
    }));
  }
}
