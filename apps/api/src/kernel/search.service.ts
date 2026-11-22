import { sampleEmbeddings, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { T002SearchFabricBySpecInput } from "@weave-order/schema";
import type { FabricSample, SpecMatch, T002SearchFabricBySpecData } from "@weave-order/schema";
import type { EmbeddingProvider } from "../platform/embedding";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { KernelContext } from "./audit";
import { mapSample, presentSample } from "./samples.service";
import { sampleEmbeddingText } from "./sample-embedding-text";
import { SampleIndexService } from "./sample-index.service";
import type { ImageIndexService } from "./image-index.service";
import { escapeLikePattern } from "./like";
import type { SampleImageService } from "./sample-images.service";
import { EmbeddingUnavailableError } from "../platform/embedding";
import type { ImageEmbeddingProvider } from "../platform/embedding";
import type { ImageCaptioner } from "../platform/caption";
import { DEFAULT_EMBEDDING_MAX_EDGE, resizeForEmbedding } from "../platform/image-resize";
import { getImageIndexWorker } from "../platform/image-index-worker";

type SampleRow = typeof samples.$inferSelect;

/**
 * 语义分支的默认最低 cosine 相似度。
 * 低于阈值的行直接不返回：宁缺毋滥，不用「负相似度映射到 0」来凑数。
 */
export const DEFAULT_SEMANTIC_MIN_SCORE = 0.5;

/**
 * 图-图检索的默认最低 cosine 相似度。
 * 实测（qwen3-vl-embedding，2026-11-14）：同款异角度 0.89~0.96，
 * 最易混的异款（浅蓝牛仔 vs 灰针织）0.61~0.69 —— 0.55 会把异款放进来，0.75 能挡住。
 */
export const DEFAULT_IMAGE_MIN_SIMILARITY = 0.75;

/**
 * 文-图检索的默认最低 cosine 相似度。
 * 图-图与文-图不是同一分布（文-图正确配对实测 0.35~0.57），
 * 套用图-图阈值会让 caption 兜底永远返回空。
 */
export const DEFAULT_IMAGE_TEXT_MIN_SIMILARITY = 0.35;

/** 以图找样的依赖集合；缺省时该能力明确报错，不退化成文本向量硬凑。 */
export interface ImageSearchDeps {
  index: ImageIndexService;
  embedder: ImageEmbeddingProvider;
  /** caption 兜底；未开启 `CAPTION_FALLBACK` 时为 null。 */
  captioner?: ImageCaptioner | null;
  /** 图-图阈值（默认 0.75）。 */
  minSimilarity?: number;
  /** 文-图阈值（默认 0.35）。 */
  textMinSimilarity?: number;
  /** 查询图送模型前缩到长边多少（默认 512，与索引侧一致）。0 = 不缩。 */
  maxEdge?: number;
}

export interface ImageSearchMatch {
  sample: FabricSample;
  score: number;
  /** 命中的具体那张图（前端高亮「你拍的这张最像这个角度的这张图」）。 */
  matchedImageId: string | null;
  matchedImageUrl: string | null;
  /** 可核对的命中理由；不写「AI 觉得像」这类无依据文案。 */
  reasons: string[];
}

export interface ImageSearchResult {
  embeddingModel: string;
  dimension: number;
  /**
   * `image`：真实图向量检索；`caption`：图向量不可用时的描述兜底。
   * 两种情况前端文案必须不同，绝不静默混用。
   */
  mode: "image" | "caption";
  /** 向量是否携带视觉语义（local-stub 为 false，前端要显示「演示模式」）。 */
  semantic: boolean;
  /** 本租户还有多少张图没索引完：前端提示「结果可能不全」，而不是显示「无结果」。 */
  indexing: number;
  matches: ImageSearchMatch[];
}

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

/** 找样检索词覆盖的字段顺序与 `matchedOn` 一致。 */
const SEARCH_COLUMNS = [
  samples.code,
  samples.name,
  samples.composition,
  samples.weightText,
] as const;

const QUERY_SEPARATORS = /[\s,，、;；|]+/;
/** 「聚酯纤维150g」这类中英文数字连写，在中文与数字交界处拆开。 */
const CJK_DIGIT_BOUNDARY = /(?<=[\u4e00-\u9fff])(?=\d)/;

/**
 * 把检索词拆成独立词元。
 *
 * 真实对话几乎总是「成分 + 克重」一起说（`聚酯纤维 150g`），而整串 ILIKE
 * 会把两个条件当成一个不可分割的字符串，必然 0 结果（WAN-160 C）。
 * 拆开后按词元分别匹配，再由调用方决定 AND / OR。
 */
export function tokenizeSearchQuery(query: string): string[] {
  const tokens: string[] = [];
  for (const part of query.split(QUERY_SEPARATORS)) {
    for (const piece of part.split(CJK_DIGIT_BOUNDARY)) {
      const token = piece.trim();
      if (token) tokens.push(token);
    }
  }
  return [...new Set(tokens)];
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
  private readonly image?: ImageSearchDeps;

  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly tenantId: string,
    private readonly sampleImages?: SampleImageService,
    private readonly semanticMinScore = DEFAULT_SEMANTIC_MIN_SCORE,
    image?: ImageSearchDeps,
  ) {
    this.index = new SampleIndexService(db, embedder, tenantId);
    this.image = image;
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
    // 草稿不建向量索引：未确认的信息不该出现在找样结果里。
    const all = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), ne(samples.status, "DRAFT")));
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

  /**
   * 以图找样（T-001 的真实现）。
   *
   * 查询图 → 多模态 embedding → pgvector HNSW topN（**图像**向量）→ 按样品去重取最高分
   * → 返回样品 + 命中的那张图 + 原始 cosine 分数 + 可核对理由。
   *
   * 图向量服务不可用且开启 `CAPTION_FALLBACK` 时，走「视觉模型描述 → 文本语义检索」，
   * 响应标 `mode: "caption"`。两条链路分数不同空间，前端文案也必须不同。
   */
  async searchByImage(
    image: { mimeType: string; base64: string },
    topK: number,
    minSimilarity?: number,
  ): Promise<ImageSearchResult> {
    if (!this.image) {
      throw new Error(
        "以图找样未配置图像 embedding provider；请注入 ImageSearchDeps，禁止用文本向量硬凑图像分数。",
      );
    }
    const { index, embedder, captioner } = this.image;
    const threshold = minSimilarity ?? this.image.minSimilarity ?? DEFAULT_IMAGE_MIN_SIMILARITY;
    const pending = await index.pendingCount();
    // 还有没索引好的图：让后台按租户节流地补一次（不阻塞本次查询）。
    if (pending > 0) getImageIndexWorker()?.requestTenantSweep(this.tenantId);
    try {
      // 查询图与索引图走同一条预处理，才能落在同一个尺度上。
      const prepared = await resizeForEmbedding(
        image,
        this.image.maxEdge ?? DEFAULT_EMBEDDING_MAX_EDGE,
      );
      const queryVector = await embedder.embedImage(prepared);
      // 多取一些候选：同一样品可能多张图命中，去重后还要凑够 topK。
      const rows = await index.searchByVector(queryVector, Math.min(topK * 5, 200), threshold);
      const best = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        // rows 已按距离升序：每个样品保留第一条（分数最高的那张图）。
        if (!best.has(row.sample.id)) best.set(row.sample.id, row);
      }
      const picked = [...best.values()].slice(0, topK);
      const primaryUrls = await this.primaryUrls(picked.map((row) => mapSample(row.sample)));
      const matches: ImageSearchMatch[] = [];
      for (const row of picked) {
        const mapped = mapSample(row.sample);
        const matchedImageUrl = this.sampleImages
          ? await this.sampleImages.urlFor(row.objectKey)
          : null;
        const reasons = [`图像相似 ${(row.score * 100).toFixed(0)}%`];
        if (!embedder.semantic) {
          reasons.unshift("演示模式：哈希向量，不代表视觉相似度");
        }
        matches.push({
          sample: { ...mapped, primaryImageUrl: primaryUrls.get(mapped.id) ?? null },
          score: Math.max(0, Math.min(1, row.score)),
          matchedImageId: row.imageId,
          matchedImageUrl,
          reasons,
        });
      }
      return {
        embeddingModel: embedder.name,
        dimension: embedder.dimension,
        mode: "image",
        semantic: embedder.semantic,
        indexing: pending,
        matches,
      };
    } catch (error) {
      // 只有「上游不可用」才允许兜底。配置错误（4xx）、维度不符、图片解不开
      // 都是必须暴露的问题，换成 caption 只会把「配错了」伪装成「换了一条链路」。
      if (!captioner || !(error instanceof EmbeddingUnavailableError)) throw error;
      return await this.searchByCaption(image, topK, captioner, pending);
    }
  }

  /** caption 兜底：视觉模型写描述 → S3 的文本语义检索。分数来自文本 cosine，与图向量不同空间。 */
  private async searchByCaption(
    image: { mimeType: string; base64: string },
    topK: number,
    captioner: ImageCaptioner,
    pending: number,
  ): Promise<ImageSearchResult> {
    const caption = await captioner.describe(image);
    const queryVector = await this.embedder.embedText(caption);
    const rows = await this.index.searchByVector(
      queryVector,
      topK,
      this.image?.textMinSimilarity ?? DEFAULT_IMAGE_TEXT_MIN_SIMILARITY,
    );
    const primaryUrls = await this.primaryUrls(rows.map((row) => mapSample(row.sample)));
    return {
      embeddingModel: this.embedder.name,
      dimension: this.embedder.dimension,
      mode: "caption",
      semantic: this.embedder.semantic,
      indexing: pending,
      matches: rows.map((row) => {
        const mapped = mapSample(row.sample);
        return {
          sample: { ...mapped, primaryImageUrl: primaryUrls.get(mapped.id) ?? null },
          score: Math.max(0, Math.min(1, row.score)),
          matchedImageId: null,
          matchedImageUrl: null,
          reasons: [`按图片描述检索：${caption}`, `文本相似 ${(row.score * 100).toFixed(0)}%`],
        };
      }),
    };
  }

  async searchBySpec(input: unknown): Promise<T002SearchFabricBySpecData> {
    const parsed = T002SearchFabricBySpecInput.parse(input);
    const tokens = tokenizeSearchQuery(parsed.query);
    // 空 token 只可能来自纯空白输入：退回整串匹配，保持旧行为。
    const terms = tokens.length > 0 ? tokens : [parsed.query];
    const termConditions = terms.map((term) => {
      const pattern = `%${escapeLikePattern(term)}%`;
      return or(...SEARCH_COLUMNS.map((column) => ilikeLiteral(column, pattern))) as SQL;
    });

    const runSearch = async (combine: "all" | "any") => {
      const filters: SQL[] = [
        (combine === "all" ? and(...termConditions) : or(...termConditions)) as SQL,
        eq(samples.tenantId, this.tenantId),
      ];
      if (parsed.composition !== undefined) {
        filters.push(
          ilikeLiteral(samples.composition, `%${escapeLikePattern(parsed.composition)}%`),
        );
      }
      return this.db
        .select()
        .from(samples)
        .where(and(ne(samples.status, "DRAFT"), ...filters))
        .orderBy(desc(samples.createdAt))
        .limit(parsed.limit);
    };

    // 先要求每个词元都命中（成分 + 克重同时成立）；全是实词却零结果时，
    // 再放宽成任一命中，避免多打了修饰词就把整条结果清零。
    let rows = await runSearch("all");
    if (rows.length === 0 && terms.length > 1) rows = await runSearch("any");

    const matches: SpecMatch[] = rows.map((row) => {
      const lowered = terms.map((term) => term.toLowerCase());
      const matchedOn: SpecMatch["matchedOn"] = [];
      const matchesAny = (value: string | null) =>
        lowered.some((term) => (value ?? "").toLowerCase().includes(term));
      if (matchesAny(row.code)) matchedOn.push("code");
      if (matchesAny(row.name)) matchedOn.push("name");
      if (matchesAny(row.composition)) matchedOn.push("composition");
      if (matchesAny(row.weightText)) matchedOn.push("weight");
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
      .where(and(eq(samples.tenantId, this.tenantId), ne(samples.status, "DRAFT")))
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
