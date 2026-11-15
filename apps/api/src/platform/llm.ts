import { createHash, randomUUID } from "node:crypto";
import {
  FollowupSuggestion,
  QuoteIntentExtraction,
  ReplyClassification,
} from "@weave-order/schema";
import type {
  FollowupChannel,
  LlmBudgetStatus,
  LlmCallReceipt,
  LlmTask,
  QuoteIntentSlots,
  ResolvedLlmSettings,
  SampleShipment,
  TrackingSnapshot,
} from "@weave-order/schema";
import { redactSensitiveText } from "./privacy";
import { isProductionLike } from "./runtime-mode";

/** 调用前的预算预留（原子检查 + 占额）；`allowed=false` 时不得发出外网请求。 */
export interface LlmReservationInput {
  requestId: string;
  task: LlmTask;
  model: string;
  provider: string;
  promptHash: string;
  reservedTokens: number;
  dailyBudget: number | null;
  monthlyBudget: number | null;
  at: string;
}

export interface LlmReservationResult {
  allowed: boolean;
  status: LlmBudgetStatus;
}

export interface LlmSettlementInput {
  requestId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  at: string;
}

export interface LlmFailureInput {
  requestId: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  at: string;
}

/**
 * 用量写入端口：由 kernel.usage 实现，platform 不直接碰数据库。
 *
 * 「预留—结算」拆成三步，是因为预算判断与扣减必须原子：
 * 先 `reserve` 占额（并发下由实现方加锁），成功后 `settle` 按实际用量结算，
 * 超时 / 非 2xx / 空回复走 `fail` 留痕，不让上游费用在库里归零。
 */
export interface LlmUsageSink {
  reserve(input: LlmReservationInput): Promise<LlmReservationResult>;
  settle(input: LlmSettlementInput): Promise<void>;
  fail(input: LlmFailureInput): Promise<void>;
  budgetStatus(dailyBudget: number | null, monthlyBudget: number | null): Promise<LlmBudgetStatus>;
}

export interface LlmProvider {
  readonly name: string;
  suggestFollowup(input: {
    customerId: string;
    shipment: SampleShipment;
    tracking: TrackingSnapshot;
  }): Promise<FollowupSuggestion>;
  classifyReply(input: { text: string }): Promise<ReplyClassification>;
  /** 报价 agent 的槽位抽取。 */
  extractQuoteIntent(input: { text: string }): Promise<QuoteIntentExtraction>;
  /**
   * 截图识别：用多模态模型抽取对话文本（一次调用完成 OCR + 理解）。
   * 只返回抽取出的文本，意图判断仍走 classifyReply，避免把两个任务混在一个 prompt。
   */
  extractReplyFromImage(input: { imageUrl: string }): Promise<{ text: string }>;
  /** 最近一次真实模型调用的用量回执；本地规则实现为 null。 */
  readonly lastUsage: LlmCallReceipt | null;
}

/** 视觉模型：截图识别专用，走同一 LiteLLM 通道，token 计入 SCREENSHOT_OCR 任务。 */
export const SCREENSHOT_VISION_MODEL = "qwen-vl-plus";

/** 多模态消息内容：文本或图片（OpenAI 兼容 image_url 协议）。 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user";
  content: string | ChatContentPart[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

interface ClassificationRule {
  pattern: RegExp;
  intent: ReplyClassification["intent"];
  confidence: number;
  summary: string;
  quoteRequested: boolean;
}

/** 规则顺序即优先级：先判价格，再判明确拒绝，再判反馈/确认。 */
const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    pattern: /报价|价格|多少钱|单价|quot(e|ation)|price/i,
    intent: "PRICE_REQUEST",
    confidence: 0.92,
    summary: "客户在询问价格，建议生成报价草稿交人类审批",
    quoteRequested: true,
  },
  {
    pattern: /不感兴趣|不需要|暂不|算了|不考虑|not interested/i,
    intent: "NOT_INTERESTED",
    confidence: 0.9,
    summary: "客户明确表示暂不需要，建议停止跟进",
    quoteRequested: false,
  },
  {
    pattern: /手感|颜色|色差|质地|面料|品质|quality|feel|texture|color/i,
    intent: "SAMPLE_FEEDBACK",
    confidence: 0.78,
    summary: "客户在反馈样品手感/颜色，建议记录到客户上下文",
    quoteRequested: false,
  },
  {
    pattern: /收到|已收到|好的|谢谢|可以|ok|okay|received|thanks/i,
    intent: "ACK",
    confidence: 0.72,
    summary: "客户已确认收到样品，建议按偏好节奏继续跟进",
    quoteRequested: false,
  },
];

const COMPOSITION_WORDS = [
  "棉",
  "涤纶",
  "聚酯",
  "亚麻",
  "羊毛",
  "真丝",
  "丝绸",
  "尼龙",
  "锦纶",
  "粘胶",
  "莫代尔",
  "天丝",
  "cotton",
  "polyester",
  "linen",
  "wool",
  "silk",
  "nylon",
  "viscose",
  "modal",
  "tencel",
];

const UNIT_ALIASES: { pattern: RegExp; unit: "meter" | "kilogram" | "yard" | "piece" }[] = [
  { pattern: /(米|m\b|meters?|metres?)/i, unit: "meter" },
  { pattern: /(公斤|千克|kg|kilograms?)/i, unit: "kilogram" },
  { pattern: /(码|yards?|yd\b)/i, unit: "yard" },
  { pattern: /(件|条|个|pcs|pieces?)/i, unit: "piece" },
];

function parseQuantity(text: string): QuoteIntentSlots["quantity"] {
  const match =
    /(\d+(?:\.\d+)?)\s*(米|m\b|meters?|metres?|公斤|千克|kg|kilograms?|码|yards?|yd\b|件|条|个|pcs|pieces?)/i.exec(
      text,
    );
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const rawUnit = match[2] ?? "";
  const unit = UNIT_ALIASES.find((entry) => entry.pattern.test(rawUnit))?.unit ?? "meter";
  return { value, unit };
}

function parseWeight(text: string): string | null {
  const match = /(\d{2,4})\s*(?:g|克)\s*(?:\/\s*(?:m2|㎡|平方米))?/i.exec(text);
  if (!match) return null;
  return /\/|每平方米|平方米/.test(match[0]) ? `${match[1]}g/m2` : `${match[1]}g`;
}

function parseComposition(text: string): string | null {
  const hits = COMPOSITION_WORDS.filter((word) => text.toLowerCase().includes(word.toLowerCase()));
  return hits.length === 0 ? null : Array.from(new Set(hits)).join("+");
}

function parseKeywords(text: string): string[] {
  const cleaned = text
    .replace(/\d+(?:\.\d+)?\s*(米|m|公斤|千克|kg|码|件|条|个|pcs|g|克)/gi, " ")
    .replace(/报价|价格|多少钱|单价|什么价|怎么卖|quote|price/gi, " ")
    .replace(/[，。,.!?！？、；;：:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((word) => word.length >= 1 && word.length <= 32);
  const unique = Array.from(new Set(words));
  return unique.slice(0, 8);
}

function localIntent(text: string): QuoteIntentExtraction {
  const slots: QuoteIntentSlots = {
    productKeywords: parseKeywords(text),
    composition: parseComposition(text),
    weight: parseWeight(text),
    quantity: parseQuantity(text),
    priceRequested: /报价|价格|多少钱|单价|什么价|怎么卖|quot(e|ation)|price/i.test(text),
    deliveryDate: /(\d{1,2}\s*月\s*\d{1,2}\s*[日号]|下周|本月|月底)/.exec(text)?.[0] ?? null,
  };
  return { slots, confidence: 0.68, provider: "local-rule-v1" };
}

/** 本地确定性实现：同样的状态输入，永远产出同样的建议。 */
export class LocalRuleLlmProvider implements LlmProvider {
  readonly name = "local-rule-v1";
  readonly lastUsage = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  suggestFollowup(input: {
    customerId: string;
    shipment: SampleShipment;
    tracking: TrackingSnapshot;
  }): Promise<FollowupSuggestion> {
    const latest = input.tracking.events[input.tracking.events.length - 1];
    const basedOnDelivery = input.tracking.status === "DELIVERED";
    const channel: FollowupChannel = "WECHAT";

    const message = basedOnDelivery
      ? `您好，样品已于 ${latest?.at.slice(0, 10) ?? "近期"} 签收，想确认一下手感和颜色是否符合预期？如有需要可以安排寄送更多色卡。`
      : `您好，样品目前物流状态为「${input.tracking.status}」（${latest?.description ?? "运输中"}），预计很快送达，收到后麻烦给个反馈。`;

    return Promise.resolve(
      FollowupSuggestion.parse({
        shipmentId: input.shipment.id,
        channel,
        suggestedAt: new Date(this.now().getTime() + 2 * DAY_MS).toISOString(),
        message,
        rationale: basedOnDelivery
          ? "物流已签收且尚无客户反馈，按签收后 2 天节奏跟进"
          : "物流在途，按到货前提醒节奏跟进",
        provider: this.name,
      }),
    );
  }

  classifyReply(input: { text: string }): Promise<ReplyClassification> {
    const text = input.text.trim();
    for (const rule of CLASSIFICATION_RULES) {
      if (rule.pattern.test(text)) {
        return Promise.resolve(
          ReplyClassification.parse({
            intent: rule.intent,
            confidence: rule.confidence,
            summary: rule.summary,
            quoteRequested: rule.quoteRequested,
            provider: this.name,
          }),
        );
      }
    }
    return Promise.resolve(
      ReplyClassification.parse({
        intent: "OTHER",
        confidence: 0.35,
        summary: "未匹配到明确意图，建议转人工查看原文",
        quoteRequested: false,
        provider: this.name,
      }),
    );
  }

  extractQuoteIntent(input: { text: string }): Promise<QuoteIntentExtraction> {
    return Promise.resolve(QuoteIntentExtraction.parse(localIntent(input.text)));
  }

  extractReplyFromImage(_input: { imageUrl: string }): Promise<{ text: string }> {
    return Promise.reject(
      new Error("截图识别需要真实视觉模型：请设置 LLM_PROVIDER=litellm 并配置视觉模型后重试。"),
    );
  }
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: ChatUsage;
}

/**
 * `llm_settings.params` 允许透传到 `/chat/completions` 的键：只留采样类参数。
 *
 * `model` / `messages` / `stream` / `max_tokens` / `response_format` 等协议控制字段
 * 必须由服务端决定——params 曾展开在它们之后，配置里带 `model` 即可覆盖模型白名单（WAN-94）。
 */
const ALLOWED_CHAT_PARAMS = new Set([
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "seed",
]);

function sanitizeChatParams(params: Record<string, unknown>): Record<string, unknown> {
  const allowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (ALLOWED_CHAT_PARAMS.has(key)) allowed[key] = value;
  }
  return allowed;
}

export interface LiteLlmOptions {
  settings: ResolvedLlmSettings;
  usage: LlmUsageSink;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * LiteLLM（OpenAI 兼容）provider。
 *
 * - 只请求 `LITELLM_BASE_URL/chat/completions`，不直连任何厂商。
 * - 每租户虚拟 Key 由 `settings.keyRef` 解析；Key 不进日志、不落库。
 * - `request_id` 随请求头下发，响应 usage 幂等写 `token_usage`。
 * - 出网前统一脱敏；prompt 只落 SHA-256。
 */
export class LiteLlmProvider implements LlmProvider {
  readonly name = "litellm";
  private usage: LlmCallReceipt | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: LiteLlmOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  get lastUsage(): LlmCallReceipt | null {
    return this.usage;
  }

  async suggestFollowup(input: {
    customerId: string;
    shipment: SampleShipment;
    tracking: TrackingSnapshot;
  }): Promise<FollowupSuggestion> {
    const latest = input.tracking.events[input.tracking.events.length - 1];
    const content = await this.chat(
      "FOLLOWUP_SUGGESTION",
      [
        {
          role: "system",
          content:
            "你是纺织贸易的寄样跟进助手。只输出 JSON：{message, rationale}。message 用中文、礼貌、不超过 200 字；rationale 说明为什么现在跟进。",
        },
        {
          role: "user",
          content: `物流状态（脱敏）：${input.tracking.status}；最近轨迹：${latest?.description ?? "无"}。请生成跟进话术。`,
        },
      ],
      this.options.settings.defaultModel,
    );
    const parsed = parseJsonObject(content);
    return FollowupSuggestion.parse({
      shipmentId: input.shipment.id,
      channel: "WECHAT",
      suggestedAt: new Date(this.now().getTime() + 2 * DAY_MS).toISOString(),
      message: asText(parsed.message, "您好，想确认一下样品是否符合预期？"),
      rationale: asText(parsed.rationale, "按物流状态生成跟进建议"),
      provider: this.name,
    });
  }

  async classifyReply(input: { text: string }): Promise<ReplyClassification> {
    const content = await this.chat(
      "REPLY_CLASSIFICATION",
      [
        {
          role: "system",
          content:
            "你是纺织贸易客户回复分类器。只输出 JSON：{intent, confidence, summary, quoteRequested}。intent 只能是 PRICE_REQUEST / SAMPLE_FEEDBACK / ACK / NOT_INTERESTED / OTHER。",
        },
        { role: "user", content: redactSensitiveText(input.text) },
      ],
      this.options.settings.defaultModel,
    );
    const parsed = parseJsonObject(content);
    return ReplyClassification.parse({
      intent: parsed.intent,
      confidence: parsed.confidence,
      summary: parsed.summary,
      quoteRequested: parsed.quoteRequested,
      provider: this.name,
    });
  }

  async extractQuoteIntent(input: { text: string }): Promise<QuoteIntentExtraction> {
    const content = await this.chat(
      "QUOTE_INTENT",
      [
        {
          role: "system",
          content:
            "你是纺织报价助手。从客户原话抽取槽位，只输出 JSON：{productKeywords:string[], composition:string|null, weight:string|null, quantity:{value:number,unit:'meter'|'kilogram'|'yard'|'piece'}|null, priceRequested:boolean, deliveryDate:string|null, confidence:number}。不要编造未出现的规格；unit 不确定时用 meter。",
        },
        { role: "user", content: redactSensitiveText(input.text) },
      ],
      this.options.settings.defaultModel,
    );
    const parsed = parseJsonObject(content);
    return QuoteIntentExtraction.parse({
      slots: {
        productKeywords: Array.isArray(parsed.productKeywords)
          ? parsed.productKeywords
              .filter((item): item is string => typeof item === "string")
              .slice(0, 20)
          : [],
        composition: parsed.composition ?? null,
        weight: parsed.weight ?? null,
        quantity: parsed.quantity ?? null,
        priceRequested: Boolean(parsed.priceRequested),
        deliveryDate: parsed.deliveryDate ?? null,
      },
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      provider: this.name,
    });
  }

  async extractReplyFromImage(input: { imageUrl: string }): Promise<{ text: string }> {
    const content = await this.chat(
      "SCREENSHOT_OCR",
      [
        {
          role: "system",
          content:
            "你是纺织贸易客户回复的截图识别助手。从聊天截图里抽取「客户本人发出的消息原文」，只输出 JSON：{text: string}。多段消息用换行连接；不要编造截图里没有的内容，也不要加入你自己的评论。",
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: input.imageUrl } }],
        },
      ],
      SCREENSHOT_VISION_MODEL,
    );
    const parsed = parseJsonObject(content);
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    return { text };
  }

  private async chat(
    task: LlmTask,
    messages: ChatMessage[],
    fallbackModel: string,
  ): Promise<string> {
    const settings = this.options.settings;
    // 按任务路由：截图识别走视觉模型；复杂报价/对账用 reasoner；超长意图也升到 reasoner。
    const promptChars = messageText(messages).length;
    const model =
      task === "SCREENSHOT_OCR"
        ? SCREENSHOT_VISION_MODEL
        : task === "QUOTE_DRAFT" || (task === "QUOTE_INTENT" && promptChars > 1200)
          ? settings.reasoningModel
          : fallbackModel;
    if (!settings.modelAllowlist.includes(model)) {
      throw new Error(`模型 ${model} 不在租户白名单内`);
    }
    const requestId = randomUUID();
    const redactedMessages = messages.map((message) => ({
      ...message,
      content: redactMessageContent(message.content),
    }));
    const promptHash = createHash("sha256")
      .update(
        redactedMessages
          .map((message) => `${message.role}:${serializeContent(message.content)}`)
          .join("\n"),
      )
      .digest("hex");

    // 预留—结算：先原子占预算，再发请求。占不到额度的请求不出网（否则无法回收成本）。
    const reservation = await this.options.usage.reserve({
      requestId,
      task,
      model,
      provider: this.name,
      promptHash,
      reservedTokens: estimateChatTokens(redactedMessages),
      dailyBudget: settings.dailyTokenBudget,
      monthlyBudget: settings.monthlyTokenBudget,
      at: this.now().toISOString(),
    });
    if (!reservation.allowed) {
      const budget = reservation.status;
      throw new Error(
        `LLM 预算已用尽（daily=${budget.dailyTokens}/${budget.dailyBudget ?? "∞"}，monthly=${budget.monthlyTokens}/${budget.monthlyBudget ?? "∞"}）`,
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          "x-request-id": requestId,
        },
        body: JSON.stringify({
          model,
          messages: redactedMessages,
          temperature: task === "QUOTE_INTENT" ? 0 : 0.2,
          response_format: { type: "json_object" },
          ...sanitizeChatParams(settings.params),
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // 超时 / 网络错误：上游可能已经计费，预留额度保留下来计入预算。
      await this.markFailed(requestId);
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      await this.markFailed(requestId);
      throw new Error(`LiteLLM 调用失败：HTTP ${response.status} ${body.slice(0, 300)}`);
    }

    let payload: ChatResponse;
    try {
      payload = (await response.json()) as ChatResponse;
    } catch (error) {
      await this.markFailed(requestId);
      throw error;
    }

    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;
    const cachedTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      // 200 但空回复：若带 usage，按已知 token 计入；否则仍保留预留额度。
      await this.markFailed(requestId, { promptTokens, completionTokens, cachedTokens });
      throw new Error("LiteLLM 返回为空：缺少 choices[0].message.content");
    }

    await this.options.usage.settle({
      requestId,
      model: payload.model ?? model,
      promptTokens,
      completionTokens,
      cachedTokens,
      at: this.now().toISOString(),
    });
    this.usage = {
      requestId,
      task,
      model: payload.model ?? model,
      provider: this.name,
      promptTokens,
      completionTokens,
      cachedTokens,
    };
    return content;
  }

  /** 计量失败不能掩盖上游错误：写库异常只吞掉，原始错误继续抛。 */
  private async markFailed(
    requestId: string,
    known: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } = {},
  ): Promise<void> {
    try {
      await this.options.usage.fail({
        requestId,
        ...known,
        at: this.now().toISOString(),
      });
    } catch {
      // 留痕失败时预算仍按预留额度保守计数（未结算的 RESERVED 行不会自动释放）。
    }
  }
}

/** 输出上限：协议未下发 max_tokens，按常见 JSON 回复上限保守预留。 */
const COMPLETION_TOKEN_ALLOWANCE = 1024;

/** 每张图保守预留（预算占额，非计费值）：取一张中等分辨率图的 token 上限。 */
const IMAGE_TOKEN_ALLOWANCE = 1105;

/** 拼接所有文本内容，用于字数估算与超长判断。 */
function messageText(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      return message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("");
    })
    .join("\n");
}

function imageCount(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => {
    if (typeof message.content === "string") return count;
    return count + message.content.filter((part) => part.type === "image_url").length;
  }, 0);
}

/** 出网前脱敏：文本替换敏感字段；图片无法脱敏，原样保留（OCR 抽取后再对文本脱敏）。 */
function redactMessageContent(content: string | ChatContentPart[]): string | ChatContentPart[] {
  if (typeof content === "string") return redactSensitiveText(content);
  return content.map((part) =>
    part.type === "text" ? { ...part, text: redactSensitiveText(part.text) } : part,
  );
}

/** 归一化序列化，用于 promptHash（图片以 url 内容参与散列，保证同图同 hash）。 */
function serializeContent(content: string | ChatContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text" ? `text:${part.text}` : `image_url:${part.image_url.url}`,
    )
    .join("\n");
}

/**
 * 调用前的 token 上限估算（预算占额，不是计费值）。
 * CJK 约 1 字符 1 token、英文约 4 字符 1 token；按 1 字符 1 token 取高不取低；
 * 图片按每张固定 token 保守预留。
 */
export function estimateChatTokens(messages: ChatMessage[]): number {
  const chars = messageText(messages).length;
  const images = imageCount(messages) * IMAGE_TOKEN_ALLOWANCE;
  return chars + images + COMPLETION_TOKEN_ALLOWANCE;
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed: unknown = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM 未返回 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

export interface CreateLlmOptions {
  settings: ResolvedLlmSettings;
  usage: LlmUsageSink;
  env?: {
    NODE_ENV?: "development" | "test" | "production";
    LITELLM_MASTER_KEY: string;
    LITELLM_TIMEOUT_MS: number;
  };
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * 密钥引用白名单（与控制面 `apps/platform-api/src/control/settings.service.ts` 同规则）：
 * 只接受 `LITELLM_MASTER_KEY` / `LITELLM_TENANT_KEY_*`（见 .env.example / docs/track-b-agents.md）。
 * 两包不共享源码，改这里必须同步控制面那份。
 */
const LLM_KEY_REF_PATTERN = /^LITELLM_(MASTER|TENANT)_KEY(?:_[A-Za-z0-9]+)*$/;

export function isAllowedLlmKeyRef(name: string): boolean {
  return LLM_KEY_REF_PATTERN.test(name);
}

/** 按配置创建 LLM provider；未知实现显式报错，不静默降级。 */
export function createLlmProvider(
  provider = "local-rule",
  options?: CreateLlmOptions,
): LlmProvider {
  if (provider === "local-rule") return new LocalRuleLlmProvider();
  if (provider === "litellm") {
    if (!options) throw new Error("LLM_PROVIDER=litellm 需要 settings / usage 配置");
    // 生产态判定统一走 isProductionLike（NODE_ENV=production 或 AUTH_MODE=oidc），
    // 避免 OIDC 已接入但 NODE_ENV 不是 production 时 fail-open（WAN-94）。
    const productionLike = isProductionLike({ ...process.env, ...options.env });
    const keyRef = options.settings.keyRef;
    const referenced = keyRef === "LITELLM_MASTER_KEY" ? undefined : keyRef;
    // 白名单外的引用名（如 DATABASE_URL）绝不读取：先判后读，禁止 process.env[引用名]。
    const resolvable = referenced && isAllowedLlmKeyRef(referenced) ? referenced : undefined;
    if (referenced && !resolvable) {
      if (productionLike) {
        throw new Error(
          `LLM keyRef "${referenced}" 不在白名单内（允许 LITELLM_MASTER_KEY / LITELLM_TENANT_KEY_*）；拒绝启动，请修正 llm_settings.key_ref`,
        );
      }
      // dev：白名单外的引用视为未配置，回退 LITELLM_MASTER_KEY（与旧的「未命中环境变量」同一路径）。
    }
    const keyFromRef = resolvable ? process.env[resolvable] : undefined;
    const keyFromMaster = options.env?.LITELLM_MASTER_KEY ?? process.env.LITELLM_MASTER_KEY;
    if (resolvable && !keyFromRef && productionLike) {
      throw new Error(
        `LLM keyRef "${resolvable}" 未命中环境变量/KMS；生产环境拒绝启动，请配置该密钥或修正 llm_settings.key_ref`,
      );
    }
    const apiKey = keyFromRef ?? keyFromMaster ?? (productionLike ? "" : "sk-local-dev");
    if (!apiKey || (productionLike && apiKey === "sk-local-dev")) {
      throw new Error(
        "生产环境缺少 LiteLLM Key（keyRef 未命中且未配置 LITELLM_MASTER_KEY），拒绝以 dev 默认值启动",
      );
    }
    return new LiteLlmProvider({
      settings: options.settings,
      usage: options.usage,
      apiKey,
      timeoutMs: options.env?.LITELLM_TIMEOUT_MS ?? 30_000,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  }
  throw new Error(
    `LLM_PROVIDER=${provider} 尚未接入；当前支持：local-rule / litellm。真实模型请实现 LlmProvider 后在此注册。`,
  );
}
