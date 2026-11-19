/**
 * 图像转文字描述（caption）。
 *
 * 只用于「图向量服务不可用」时的兜底链路：视觉模型写一句中文描述，
 * 再走 S3 的文本语义检索。响应里必须标 `mode: "caption"`，绝不与图向量结果混用。
 *
 * 与 embedding 一样直连 DashScope 兼容端点，base_url / key / model 全部来自 env；
 * 截图识别链路走通用 OpenAI 兼容企业网关，两条链路互不复用。
 */

export interface CaptionInput {
  mimeType: string;
  base64: string;
}

export interface ImageCaptioner {
  readonly name: string;
  describe(image: CaptionInput): Promise<string>;
}

export interface CaptionerOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_CAPTION_MODEL = "qwen3-vl-plus";
export const DEFAULT_CAPTION_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 给视觉模型的固定指令：只描述可核对的客观特征，不评价、不编造。 */
export const CAPTION_PROMPT =
  "用中文 60 字以内客观描述这块面料的：颜色、图案、材质质感、织法（平纹/斜纹/针织等）。" +
  "只输出描述本身，不要形容词堆砌，不要猜测品牌或用途。";

export class DashScopeCaptioner implements ImageCaptioner {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CaptionerOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("caption 需要 IMAGE_EMBEDDING_API_KEY 或 DASHSCOPE_API_KEY；没有 key 请不要开启 CAPTION_FALLBACK。");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_CAPTION_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_CAPTION_MODEL;
    this.name = this.model;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async describe(image: CaptionInput): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 160,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
                { type: "text", text: CAPTION_PROMPT },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new Error(
        aborted
          ? `caption 请求超时（${this.timeoutMs}ms）：${this.baseUrl}/chat/completions`
          : `caption 网络错误：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`caption 失败 HTTP ${response.status}：${detail || "无响应体"}`);
    }
    const payload = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[];
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("caption 响应里没有可用的描述文本");
    }
    return content.trim().slice(0, 500);
  }
}

export interface CaptionEnv {
  CAPTION_MODEL: string;
  CAPTION_BASE_URL: string;
  IMAGE_EMBEDDING_TIMEOUT_MS: number;
}

/** captioner 仅在显式开启兜底时创建；否则返回 null（主路径不承担这条依赖）。 */
export function createCaptionerFromEnv(
  env: CaptionEnv,
  enabled: boolean,
  apiKey?: string,
): ImageCaptioner | null {
  if (!enabled) return null;
  return new DashScopeCaptioner({
    apiKey: apiKey ?? "",
    baseUrl: env.CAPTION_BASE_URL,
    model: env.CAPTION_MODEL,
    timeoutMs: env.IMAGE_EMBEDDING_TIMEOUT_MS,
  });
}
