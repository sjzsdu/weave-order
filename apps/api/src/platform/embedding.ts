/**
 * Embedding provider 接口。
 *
 * 两种模式的语义差异（必须写进文档，也决定了检索行为）：
 * - `local-stub`：16 维 FNV 哈希，确定性、零 key、可离线跑测试与演示。
 *   **它不携带语义**：相似度只反映字符串形态，不能用来做「文字找同义样」。
 * - `dashscope-text-v3`：通义 `text-embedding-v3`（1024 维），真实语义向量。
 *   供 pgvector + HNSW 检索使用；失败必须抛错，绝不回退到哈希（回退会得到
 *   「看起来正常但没有意义」的分数）。
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  /**
   * 向量是否携带语义。`local-stub` 为 false —— 检索层据此决定是否启用向量分支，
   * 而不是把哈希分数当成语义分数返回。
   */
  readonly semantic: boolean;
  embedText(text: string): Promise<number[]>;
  /** 批量入口；实现内部按厂商限制切片，返回顺序与入参一致。 */
  embedTexts(texts: string[]): Promise<number[][]>;
  embedImage(image: { mimeType: string; base64: string }): Promise<number[]>;
}

/** 16 维本地 stub：FNV-1a 哈希散列到固定维度后做 L2 归一化。 */
const STUB_DIMENSION = 16;

function hashVector(bytes: Uint8Array): number[] {
  const vector: number[] = [];
  for (let i = 0; i < STUB_DIMENSION; i += 1) vector.push(0);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    vector[i % STUB_DIMENSION] = (vector[i % STUB_DIMENSION] ?? 0) + ((hash % 2001) - 1000) / 1000;
  }
  if (vector.every((value) => value === 0)) return [1, ...vector.slice(1)];
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

export class LocalStubEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local-stub-v1";
  readonly dimension = STUB_DIMENSION;
  readonly semantic = false;

  embedText(text: string): Promise<number[]> {
    return this.embedTexts([text]).then((vectors) => {
      const vector = vectors[0];
      if (!vector) throw new Error("embedText 未返回向量");
      return vector;
    });
  }

  embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.some((text) => text.trim().length === 0)) {
      return Promise.reject(new Error("embedText 需要非空文本"));
    }
    return Promise.resolve(texts.map((text) => hashVector(Buffer.from(text, "utf8"))));
  }

  embedImage(image: { mimeType: string; base64: string }): Promise<number[]> {
    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.length === 0) {
      return Promise.reject(new Error(`图像内容为空或 base64 非法（mimeType=${image.mimeType}）`));
    }
    // 把 mimeType 也纳入哈希，避免不同格式的同名文件算出完全无关的向量。
    return Promise.resolve(hashVector(Buffer.concat([Buffer.from(image.mimeType, "utf8"), bytes])));
  }
}

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-v3";
export const DEFAULT_EMBEDDING_DIMENSION = 1024;
export const DEFAULT_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** 通义 embedding 单次最多 10 条。 */
export const DASHSCOPE_EMBEDDING_MAX_BATCH = 10;

export interface DashScopeEmbeddingOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimension?: number;
  timeoutMs?: number;
  maxBatchSize?: number;
  /** 总尝试次数（含首次）；默认 3。 */
  maxAttempts?: number;
  /** 指数退避基数（毫秒）：250 → 500。 */
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
}

interface DashScopeEmbeddingResponse {
  data?: { embedding?: unknown; index?: unknown }[];
  error?: { message?: unknown; code?: unknown };
}

class EmbeddingRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingRequestError";
  }
}

function isFiniteVector(value: unknown, dimension: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimension &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/**
 * 通义 `text-embedding-v3`（OpenAI 兼容 `/v1/embeddings`）。
 *
 * 为什么直连 DashScope 而不是走 LiteLLM 网关：
 * 本地网关当前只收录对话模型（deepseek / qwen），embedding 与对话的计费、超时、
 * 重试语义不同；直连可以把 base_url / key 都留在 env，不要求改网关配置并重启，
 * 也不用把 embedding key 注入网关。以后网关收录该模型时，只需改 `EMBEDDING_BASE_URL`。
 */
export class DashScopeTextEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  readonly semantic = true;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxBatchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DashScopeEmbeddingOptions) {
    if (!options.apiKey.trim()) {
      throw new Error(
        "EMBEDDING_PROVIDER=dashscope-text-v3 需要 EMBEDDING_API_KEY（或 DASHSCOPE_API_KEY）；" +
          "没有 key 时请使用 local-stub，不要静默降级。",
      );
    }
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.name = `dashscope-${this.model}`;
    this.dimension = options.dimension ?? DEFAULT_EMBEDDING_DIMENSION;
    if (this.dimension <= 0) throw new Error(`EMBEDDING_DIMENSION 非法：${this.dimension}`);
    this.baseUrl = (options.baseUrl ?? DEFAULT_EMBEDDING_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.maxBatchSize = Math.min(
      Math.max(options.maxBatchSize ?? DASHSCOPE_EMBEDDING_MAX_BATCH, 1),
      DASHSCOPE_EMBEDDING_MAX_BATCH,
    );
    this.maxAttempts = Math.max(options.maxAttempts ?? 3, 1);
    this.retryBaseMs = Math.max(options.retryBaseMs ?? 250, 0);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embedText(text: string): Promise<number[]> {
    const [vector] = await this.embedTexts([text]);
    if (!vector) throw new Error("embedText 未返回向量");
    return vector;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim().length === 0)) {
      throw new Error("embedText 需要非空文本");
    }
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.maxBatchSize) {
      vectors.push(...(await this.requestBatch(texts.slice(offset, offset + this.maxBatchSize))));
    }
    return vectors;
  }

  embedImage(_image: { mimeType: string; base64: string }): Promise<number[]> {
    // 文本模型不能把图映到同一空间；以图找样由 S4 的多模态模型实现。
    return Promise.reject(
      new Error(
        `embedding provider ${this.name} 只支持文本；以图找样需要多模态 embedding（S4），` +
          "不允许用文本向量硬凑图像分数。",
      ),
    );
  }

  private async requestBatch(texts: string[]): Promise<number[][]> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(texts);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof EmbeddingRequestError && !error.retryable) throw error;
        if (attempt < this.maxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.retryBaseMs * 2 ** (attempt - 1)),
          );
        }
      }
    }
    throw new Error(
      `embedding 调用失败（model=${this.name}，已尝试 ${this.maxAttempts} 次）：` +
        `${lastError?.message ?? "未知错误"}`,
    );
  }

  private async requestOnce(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimension,
          encoding_format: "float",
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // AbortError 与网络错误都可重试；超时信息要能被人看懂。
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new EmbeddingRequestError(
        aborted
          ? `请求超时（${this.timeoutMs}ms）：${this.baseUrl}/embeddings`
          : `网络错误：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      // 4xx（除 429）是配置/输入问题，重试没有意义。
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbeddingRequestError(
        `HTTP ${response.status} ${response.statusText}：${detail || "无响应体"}`,
        retryable,
      );
    }

    const payload = (await response.json().catch(() => null)) as DashScopeEmbeddingResponse | null;
    const data = payload?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      const upstream = payload?.error?.message;
      throw new EmbeddingRequestError(
        `响应条数不符：期望 ${texts.length} 条，实际 ${Array.isArray(data) ? data.length : "无 data"}；` +
          `上游 error=${typeof upstream === "string" ? upstream : "无"}`,
        true,
      );
    }
    // OpenAI 兼容响应带 index；缺省时按数组顺序。
    const ordered = [...data].sort((left, right) => {
      const li = typeof left?.index === "number" ? left.index : 0;
      const ri = typeof right?.index === "number" ? right.index : 0;
      return li - ri;
    });
    return ordered.map((item, position) => {
      if (!isFiniteVector(item?.embedding, this.dimension)) {
        const length = Array.isArray(item?.embedding) ? item.embedding.length : "非数组";
        throw new EmbeddingRequestError(
          `第 ${position} 条向量维度非法（期望 ${this.dimension}，实际 ${length}）`,
          true,
        );
      }
      return item.embedding;
    });
  }
}

export interface EmbeddingProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimension?: number;
  timeoutMs?: number;
  maxBatchSize?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

/** env 中与 embedding 相关的字段（结构化定义，避免 platform 层反向依赖 env 模块）。 */
export interface EmbeddingEnv {
  EMBEDDING_PROVIDER: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSION: number;
  EMBEDDING_BASE_URL: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_TIMEOUT_MS: number;
  EMBEDDING_MAX_ATTEMPTS: number;
}

/** 按环境变量创建 provider（内核与 CLI 共用同一处，避免两套默认值）。 */
export function createEmbeddingProviderFromEnv(
  env: EmbeddingEnv,
  fallbackApiKey?: string,
): EmbeddingProvider {
  return createEmbeddingProvider(env.EMBEDDING_PROVIDER, {
    baseUrl: env.EMBEDDING_BASE_URL,
    apiKey: env.EMBEDDING_API_KEY ?? fallbackApiKey,
    model: env.EMBEDDING_MODEL,
    dimension: env.EMBEDDING_DIMENSION,
    timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    maxAttempts: env.EMBEDDING_MAX_ATTEMPTS,
  });
}

/**
 * 按配置创建 provider。
 * 未知 provider 显式报错，不会悄悄退回 local-stub。
 */
export function createEmbeddingProvider(
  provider = "local-stub",
  options: EmbeddingProviderOptions = {},
): EmbeddingProvider {
  if (provider === "local-stub") return new LocalStubEmbeddingProvider();
  if (provider === "dashscope-text-v3") {
    return new DashScopeTextEmbeddingProvider({
      apiKey: options.apiKey ?? "",
      baseUrl: options.baseUrl,
      model: options.model,
      dimension: options.dimension,
      timeoutMs: options.timeoutMs,
      maxBatchSize: options.maxBatchSize,
      maxAttempts: options.maxAttempts,
      fetchImpl: options.fetchImpl,
    });
  }
  throw new Error(
    `EMBEDDING_PROVIDER=${provider} 尚未接入；当前支持：local-stub、dashscope-text-v3。`,
  );
}
