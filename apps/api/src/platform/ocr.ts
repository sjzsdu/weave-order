import type { OcrFailureCode } from "@weave-order/schema";
import type { Env } from "./env";
import { isPlaceholderLlmKey } from "./env";

/**
 * 无状态 OCR 调用层（路线 B：专用 OCR 出文本 + 文本模型按字段抽取）。
 *
 * 为什么不在 kernel 里直接 fetch：
 * - OCR 是外部、慢、会失败的资源，内核只应处理「结果与降级」；
 * - 测试可以把 `OcrGateway` 换成确定性假实现，不需要网络；
 * - 换 OCR 引擎（PaddleOCR 私有化）只改这一层，抽取 prompt 与字段契约不变。
 *
 * 失败不抛「部分成功」：要么拿到文本 + 字段，要么带机器可读 failureCode 抛 OcrError。
 */
export type OcrDocumentKind = "bizcard" | "label";

export interface OcrRecognizeInput {
  bytes: Buffer;
  mimeType: string;
  kind: OcrDocumentKind;
}

export interface OcrRecognizeResult {
  /** 专用 OCR 出的原始文本；保留可回看，字段抽取错了能定位。 */
  text: string;
  /** 抽取出的结构化字段；空字符串表示「模型没有给出」，调用方不得猜。 */
  fields: Record<string, string>;
  engine: string;
  raw: Record<string, unknown>;
  latencyMs: number;
}

export interface OcrGateway {
  readonly name: string;
  recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult>;
}

export class OcrError extends Error {
  constructor(
    readonly code: OcrFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "OcrError";
  }
}

const CARD_FIELDS = [
  "company",
  "contact",
  "title",
  "phone",
  "tel",
  "address",
  "business",
  "email",
] as const;
const LABEL_FIELDS = ["product", "composition", "gsm", "width", "lot", "supplier"] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** 对象存储头里的 contentType 可能缺失；从 objectKey 后缀补一个。 */
export function mimeTypeOf(objectKey: string, fallback?: string | null): string {
  if (fallback && fallback.length > 0) return fallback;
  const ext = objectKey.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function promptFor(kind: OcrDocumentKind): string {
  if (kind === "bizcard") {
    return [
      "你是纺织贸易公司的资料录入员。请从这张名片图片中抽取字段。",
      "字段：company 公司全称；contact 联系人姓名；title 职务；phone 手机号（标有 手机/Mobile 的号码；只有一个号码时放这里）；tel 固定电话（标有 电话/Tel 的号码）；address 地址；business 主营业务或产品；email 邮箱。",
      "只输出一个 JSON 对象，键名必须是上面八个英文字段。",
      "证据约束：company 只填名片上印出的完整公司名，品牌名不算公司全称；business 只在名片明确写出 主营/业务/产品 时填写，不得根据公司名推断；无法确认或图片中没有的字段输出空字符串，严禁猜测、补全或翻译。",
    ].join("\n");
  }
  return [
    "你是纺织贸易公司的面料资料录入员。请从这张面料/服装标签图片中抽取字段。",
    "字段：product 品名；composition 成分（按标签原文，含百分比）；gsm 克重（g/m² 或 GSM）；width 门幅（cm 或英寸）；lot 批号/色号/款号；supplier 供应商或品牌方。",
    "只输出一个 JSON 对象，键名必须是上面六个英文字段。",
    "证据约束：product 只在标签明确印有 品名/商品名/Product 时填写，品牌名、系列名、公司名都不是品名；gsm 只在明确标注 克重/GSM/g/m² 时填写，净重、尺码、件重都不算；width 只在明确标注 门幅/幅宽/Width 时填写，服装尺码（170/90）和床品尺寸（150*200cm）都不算；lot 只在明确标注 批号/色号/款号/货号/型号/SN 时填写，品牌名不算；supplier 填标签上印制的公司主体，不填广告语或品牌口号；composition 只填纤维成分百分比，忽略洗涤说明。无法确认或标签上没有的字段输出空字符串，严禁猜测或用常见值补全。",
  ].join("\n");
}

function extractionPrompt(kind: OcrDocumentKind): string {
  return [
    `下面是一张${kind === "bizcard" ? "名片" : "面料/服装标签"}的 OCR 文本，可能包含识别错误、换行错位和无关内容。`,
    "请只依据这段文本抽取字段，不要引入外部知识。",
    promptFor(kind),
  ].join("\n");
}

function parseFields(reply: string, fields: readonly string[]): Record<string, string> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const raw = (fenced?.[1] ?? reply).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型回复不是 JSON");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = parsed[field];
    out[field] =
      typeof value === "string" ? value.trim() : value == null ? "" : JSON.stringify(value).trim();
  }
  return out;
}

interface ChatCallOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  content: unknown;
  maxTokens: number;
  timeoutMs: number;
}

async function callChat(options: ChatCallOptions): Promise<{ reply: string; usage: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: options.maxTokens,
        messages: [{ role: "user", content: options.content }],
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: unknown;
    };
    const reply = body.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || reply.trim().length === 0) throw new Error("空回复");
    return { reply, usage: body.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DashScope OpenAI 兼容实现：OCR 模型出文本 → 文本模型按字段抽取。
 * 与 spike 脚本同一套 prompt 与字段，方便用真实样本复跑比对。
 */
export class OpenAiCompatibleOcrGateway implements OcrGateway {
  readonly name: string;

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      ocrModel: string;
      extractModel: string;
      timeoutMs: number;
      maxAttempts: number;
    },
  ) {
    this.name = `route-b:${options.ocrModel}+${options.extractModel}`;
  }

  async recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
    const started = Date.now();
    const imageContent = [
      {
        type: "image_url",
        image_url: { url: `data:${input.mimeType};base64,${input.bytes.toString("base64")}` },
      },
      { type: "text", text: "提取图中所有文字，按阅读顺序输出，保留换行。不要输出坐标或解释。" },
    ];
    const ocr = await this.retry(() =>
      callChat({
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey,
        model: this.options.ocrModel,
        content: imageContent,
        maxTokens: 1500,
        timeoutMs: this.options.timeoutMs,
      }),
    );
    const extraction = await this.retry(() =>
      callChat({
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey,
        model: this.options.extractModel,
        content: `${extractionPrompt(input.kind)}\n\nOCR 文本：\n${ocr.reply}`,
        maxTokens: 600,
        timeoutMs: this.options.timeoutMs,
      }),
    );
    const fields = parseFields(
      extraction.reply,
      input.kind === "bizcard" ? CARD_FIELDS : LABEL_FIELDS,
    );
    return {
      text: ocr.reply,
      fields,
      engine: this.name,
      raw: { ocrUsage: ocr.usage, extractUsage: extraction.usage },
      latencyMs: Date.now() - started,
    };
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        last = error;
        if (attempt < this.options.maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
        }
      }
    }
    const message = last instanceof Error ? last.message : String(last);
    const code: OcrFailureCode = /abort|timeout|timed?\s?out/i.test(message)
      ? "TIMEOUT"
      : "PROVIDER_ERROR";
    throw new OcrError(code, `OCR 调用失败：${message.slice(0, 200)}`);
  }
}

/** 未配置 key 时的显式不可用实现：绝不返回假字段，让任务进入 NEEDS_INPUT。 */
export class DisabledOcrGateway implements OcrGateway {
  readonly name = "disabled";
  recognize(): Promise<OcrRecognizeResult> {
    return Promise.reject(
      new OcrError("PROVIDER_ERROR", "OCR 未配置：请设置 OCR_API_KEY 或 DASHSCOPE_API_KEY"),
    );
  }
}

export function createOcrGatewayFromEnv(env: Env): OcrGateway {
  const apiKey = env.OCR_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey || isPlaceholderLlmKey(apiKey)) return new DisabledOcrGateway();
  return new OpenAiCompatibleOcrGateway({
    baseUrl: env.OCR_BASE_URL,
    apiKey,
    ocrModel: env.OCR_OCR_MODEL,
    extractModel: env.OCR_EXTRACT_MODEL,
    timeoutMs: env.OCR_TIMEOUT_MS,
    maxAttempts: env.OCR_MAX_ATTEMPTS,
  });
}
