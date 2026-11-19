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
  /**
   * Complete multimodal embedding endpoint. When set it is used verbatim
   * (e.g. the one-api gateway route); otherwise the provider falls back to
   * baseUrl + the native DashScope suffix.
   */
  endpoint?: string;
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

/**
 * 上游**不可用**（超时 / 网络 / 5xx / 429，且重试耗尽）。
 *
 * 只有这一类错误允许走 caption 兜底：配置错误（4xx）、维度不符、输入非法
 * 都不该被兜底吞掉 —— 那会把「配错了」伪装成「换了一条链路」。
 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
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
 * 把上游失败响应转成一眼能看懂的一句话。
 *
 * 直连百炼返回 `{code, message}`，one-api 网关返回 `{error:{message,type,code}}`；
 * 直接截断原始 JSON 会把真正的原因（如「该令牌无权使用模型」）埋在大括号之间。
 * 解析失败时退回原文截断，保证任何响应都有可读信息。
 */
function describeUpstreamError(status: number, statusText: string, body: string): string {
  const raw = body.trim();
  let detail = "";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === "string") detail = message.trim();
    } catch {
      // JSON 被截断或不是合法 JSON：保留原文
    }
  }
  const text = detail || raw.slice(0, 300);
  return `HTTP ${status} ${statusText}：${text || "无响应体"}`;
}

/**
 * 通义 `text-embedding-v3`（OpenAI 兼容 `/v1/embeddings`）。
 *
 * 为什么 embedding 不复用对话网关：embedding 与对话的计费、超时、重试语义不同；
 * 直连可以把 base_url / key 都留在 env，不要求改网关配置并重启，也不用把
 * embedding key 注入网关。以后网关收录该模型时，只需改 `EMBEDDING_BASE_URL`。
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
    throw new EmbeddingUnavailableError(
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
      const body = await response.text().catch(() => "");
      // 4xx（除 429）是配置/输入问题，重试没有意义。
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbeddingRequestError(
        describeUpstreamError(response.status, response.statusText, body),
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
  endpoint?: string;
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

/* ============================ 多模态（图像）embedding ============================ */

/**
 * 图像 embedding provider。
 *
 * 与文本 provider 分开的原因不是洁癖：多模态模型的**图向量与文向量同空间**，
 * 但它们的分数分布和文本模型（`text-embedding-v3`）完全不是一回事。
 * 混用会让「图搜图」与「文搜样」互相污染阈值，所以两套 provider、两张表、两组阈值。
 */
export interface ImageEmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  /** 是否携带视觉语义。本地 stub 为 false：检索层据此标记 `semantic:false`，不冒充真实分数。 */
  readonly semantic: boolean;
  /** 单次请求最多送几张图（通义多模态 10 张/请求）。 */
  readonly maxImagesPerRequest: number;
  embedImage(image: ImageEmbeddingInput): Promise<number[]>;
  embedImages(images: ImageEmbeddingInput[]): Promise<number[][]>;
}

export interface ImageEmbeddingInput {
  mimeType: string;
  base64: string;
}

export const DEFAULT_IMAGE_EMBEDDING_MODEL = "qwen3-vl-embedding";
export const DEFAULT_IMAGE_EMBEDDING_DIMENSION = 1024;
export const DEFAULT_IMAGE_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
export const DASHSCOPE_MULTIMODAL_MAX_IMAGES = 10;
/** 通义多模态向量支持的维度档位（实测 512/1024/1536/2560 分离度差异 <0.03）。 */
export const DASHSCOPE_MULTIMODAL_DIMENSIONS = [256, 512, 768, 1024, 1536, 2048, 2560] as const;

/**
 * 本地图像 stub：与文本 stub 同一套哈希，只用于无 key 的本地演示与测试。
 * `semantic=false` —— 分数只反映字节形态，不代表「看起来像」。
 */
export class LocalStubImageEmbeddingProvider implements ImageEmbeddingProvider {
  readonly name = "local-stub-image-v1";
  readonly dimension = STUB_DIMENSION;
  readonly semantic = false;
  readonly maxImagesPerRequest = 8;

  embedImage(image: ImageEmbeddingInput): Promise<number[]> {
    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.length === 0) {
      return Promise.reject(new Error(`图像内容为空或 base64 非法（mimeType=${image.mimeType}）`));
    }
    return Promise.resolve(hashVector(Buffer.concat([Buffer.from(image.mimeType, "utf8"), bytes])));
  }

  async embedImages(images: ImageEmbeddingInput[]): Promise<number[][]> {
    return Promise.all(images.map((image) => this.embedImage(image)));
  }
}

/**
 * 通义多模态向量（`qwen3-vl-embedding`）。
 *
 * 为什么直连 DashScope 原生端点而不是 OpenAI 兼容端点：
 * 多模态向量的**独立向量**（一张图一个向量）只在原生
 * `/api/v1/services/embeddings/multimodal-embedding` 上提供，
 * 兼容端点只能做对话，没有 image embedding 入口。
 *
 * 实测约束（2026-11-14，用真实 key）：
 * - 单请求最多 10 张图 / 20 个 content；
 * - 图片支持 base64 data URI；老模型 `multimodal-embedding-v1` 只允许 1 张，故不选；
 * - 256px 图 64 token、512px 256 token，分离度基本持平，所以索引前先缩图。
 */
export class DashScopeMultiModalEmbeddingProvider implements ImageEmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  readonly semantic = true;
  readonly maxImagesPerRequest: number;
  private readonly model: string;
  private readonly baseUrl: string;
  /** Full endpoint used by requests; see DashScopeEmbeddingOptions.endpoint. */
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DashScopeEmbeddingOptions) {
    if (!options.apiKey.trim()) {
      throw new Error(
        "IMAGE_EMBEDDING_PROVIDER=dashscope-qwen3-vl 需要 IMAGE_EMBEDDING_API_KEY" +
          "（直连百炼时可用 DASHSCOPE_API_KEY；走 one-api 网关时填网关令牌）；" +
          "没有 key 时请用 local-stub，不要静默降级。",
      );
    }
    this.model = options.model ?? DEFAULT_IMAGE_EMBEDDING_MODEL;
    this.name = `dashscope-${this.model}`;
    this.dimension = options.dimension ?? DEFAULT_IMAGE_EMBEDDING_DIMENSION;
    if (this.dimension <= 0) throw new Error(`IMAGE_EMBEDDING_DIMENSION 非法：${this.dimension}`);
    this.baseUrl = (options.baseUrl ?? DEFAULT_IMAGE_EMBEDDING_BASE_URL).replace(/\/+$/, "");
    // IMAGE_EMBEDDING_ENDPOINT wins when provided (one-api gateway route).
    // The fallback uses a single suffix segment; the old double suffix only
    // worked because the upstream router happened to tolerate it.
    this.endpoint =
      options.endpoint?.trim() ||
      `${this.baseUrl}/services/embeddings/multimodal-embedding`;
    this.apiKey = options.apiKey;
    this.maxImagesPerRequest = Math.max(
      1,
      Math.min(options.maxBatchSize ?? DASHSCOPE_MULTIMODAL_MAX_IMAGES, DASHSCOPE_MULTIMODAL_MAX_IMAGES),
    );
    this.maxAttempts = Math.max(options.maxAttempts ?? 3, 1);
    this.retryBaseMs = Math.max(options.retryBaseMs ?? 250, 0);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embedImage(image: ImageEmbeddingInput): Promise<number[]> {
    const [vector] = await this.embedImages([image]);
    if (!vector) throw new Error("embedImage 未返回向量");
    return vector;
  }

  async embedImages(images: ImageEmbeddingInput[]): Promise<number[][]> {
    if (images.length === 0) return [];
    const vectors: number[][] = [];
    for (let offset = 0; offset < images.length; offset += this.maxImagesPerRequest) {
      vectors.push(
        ...(await this.requestBatch(images.slice(offset, offset + this.maxImagesPerRequest))),
      );
    }
    return vectors;
  }

  private async requestBatch(images: ImageEmbeddingInput[]): Promise<number[][]> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(images);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof EmbeddingRequestError && !error.retryable) throw error;
        if (attempt < this.maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this.retryBaseMs * 2 ** (attempt - 1)));
        }
      }
    }
    throw new EmbeddingUnavailableError(
      `图像 embedding 调用失败（model=${this.name}，已尝试 ${this.maxAttempts} 次）：` +
        `${lastError?.message ?? "未知错误"}`,
    );
  }

  private async requestOnce(images: ImageEmbeddingInput[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: {
            contents: images.map((image) => ({
              image: `data:${image.mimeType};base64,${image.base64}`,
            })),
          },
          parameters: { dimension: this.dimension },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new EmbeddingRequestError(
        aborted ? `请求超时（${this.timeoutMs}ms）：${this.endpoint}` : `网络错误：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 400 常见于「维度不支持 / base64 非法 / 单批超限」——重试不会变好。
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbeddingRequestError(
        describeUpstreamError(response.status, response.statusText, body),
        retryable,
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      output?: { embeddings?: { embedding?: unknown }[] };
      usage?: unknown;
      code?: unknown;
      message?: unknown;
    } | null;
    const embeddings = payload?.output?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== images.length) {
      throw new EmbeddingRequestError(
        `响应条数不符：期望 ${images.length} 条，实际 ${Array.isArray(embeddings) ? embeddings.length : "无 embeddings"}；` +
          `上游 code=${typeof payload?.code === "string" ? payload.code : "无"} ` +
          `message=${typeof payload?.message === "string" ? payload.message : "无"}`,
        true,
      );
    }
    return embeddings.map((item, position) => {
      if (!isFiniteVector(item?.embedding, this.dimension)) {
        const length = Array.isArray(item?.embedding) ? item.embedding.length : "非数组";
        throw new EmbeddingRequestError(
          `第 ${position} 条向量维度非法（期望 ${this.dimension}，实际 ${length}）；` +
            "若换了模型，请同步改 IMAGE_EMBEDDING_DIMENSION 并新建同维度的 HNSW 索引",
          false,
        );
      }
      return item.embedding;
    });
  }
}

export interface ImageEmbeddingEnv {
  IMAGE_EMBEDDING_PROVIDER: string;
  IMAGE_EMBEDDING_MODEL: string;
  IMAGE_EMBEDDING_DIMENSION: number;
  IMAGE_EMBEDDING_BASE_URL: string;
  IMAGE_EMBEDDING_ENDPOINT?: string;
  IMAGE_EMBEDDING_API_KEY?: string;
  IMAGE_EMBEDDING_TIMEOUT_MS: number;
  IMAGE_EMBEDDING_MAX_ATTEMPTS: number;
}

/** 按环境变量创建图像 provider；未知 provider 显式报错，不退回 stub。 */
export function createImageEmbeddingProviderFromEnv(
  env: ImageEmbeddingEnv,
  fallbackApiKey?: string,
): ImageEmbeddingProvider {
  return createImageEmbeddingProvider(env.IMAGE_EMBEDDING_PROVIDER, {
    baseUrl: env.IMAGE_EMBEDDING_BASE_URL,
    endpoint: env.IMAGE_EMBEDDING_ENDPOINT,
    apiKey: env.IMAGE_EMBEDDING_API_KEY ?? fallbackApiKey,
    model: env.IMAGE_EMBEDDING_MODEL,
    dimension: env.IMAGE_EMBEDDING_DIMENSION,
    timeoutMs: env.IMAGE_EMBEDDING_TIMEOUT_MS,
    maxAttempts: env.IMAGE_EMBEDDING_MAX_ATTEMPTS,
  });
}

export function createImageEmbeddingProvider(
  provider = "local-stub",
  options: EmbeddingProviderOptions = {},
): ImageEmbeddingProvider {
  if (provider === "local-stub") return new LocalStubImageEmbeddingProvider();
  if (provider === "dashscope-qwen3-vl") {
    return new DashScopeMultiModalEmbeddingProvider({
      apiKey: options.apiKey ?? "",
      baseUrl: options.baseUrl,
      endpoint: options.endpoint,
      model: options.model,
      dimension: options.dimension,
      timeoutMs: options.timeoutMs,
      maxBatchSize: options.maxBatchSize,
      maxAttempts: options.maxAttempts,
      fetchImpl: options.fetchImpl,
    });
  }
  throw new Error(
    `IMAGE_EMBEDDING_PROVIDER=${provider} 尚未接入；当前支持：local-stub、dashscope-qwen3-vl。`,
  );
}
