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
import { DEV_LLM_API_KEY, isPlaceholderLlmKey } from "./env";
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
  /**
   * 最近一次「主 provider 失败、已回退本地规则」的记录。
   * 只有 `FallbackLlmProvider` 会设置它；本地规则实现恒为 undefined。
   */
  readonly lastFallback?: LlmFallbackNotice | null;
}

/** 一次降级的事实：哪个任务失败了、给人看的原因（绝不含网关原文 / request id）。 */
export interface LlmFallbackNotice {
  task: LlmTask;
  reason: string;
}

/**
 * 把上游模型错误收成人话。
 *
 * 网关的 4xx 响应体里带 request id 与内部模型名，直接透给前端既是噪音也是信息泄漏；
 * 这里只保留「哪个环节出了问题」，具体排查靠服务端日志与用量表。
 */
export function humanizeLlmError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const http = /企业模型网关调用失败：HTTP (\d{3})/.exec(raw);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) {
      return `模型网关拒绝了本次调用（HTTP ${status}）：令牌可能无权使用当前模型`;
    }
    if (status === 429) return "模型网关限流了本次调用（HTTP 429），稍后会自动重试";
    if (status >= 500) return `模型网关暂时不可用（HTTP ${status}）`;
    return `模型网关拒绝了本次调用（HTTP ${status}）`;
  }
  if (/abort|timed?\s*out|timeout|fetch failed|ECONN|EAI_AGAIN|ENOTFOUND/i.test(raw)) {
    return "模型网关响应超时或网络不可达";
  }
  if (
    raw.includes("不在租户白名单") ||
    raw.includes("未配置") ||
    raw.includes("预算已用尽") ||
    raw.includes("缺少 LLM") ||
    raw.includes("不受支持")
  ) {
    // 这些错误本身就是写给人看的配置提示，不含密钥与请求 id。
    return raw.slice(0, 200);
  }
  return "模型服务暂时不可用";
}

/**
 * 主 provider 失败即回退本地规则，保证「模型坏了也不影响出结果」。
 *
 * 报价格式抽取、客户回复分类、跟进建议都有确定性实现；只有截图 OCR 没有本地替代，
 * 回退后仍会失败，但至少错误已经是人话且原文保留。
 */
export class FallbackLlmProvider implements LlmProvider {
  readonly name: string;
  private fallbackNotice: LlmFallbackNotice | null = null;
  private readonly initialReason: string | null;

  constructor(
    private readonly primary: LlmProvider | null,
    private readonly fallback: LlmProvider = new LocalRuleLlmProvider(),
    initialReason?: string,
  ) {
    this.name = primary?.name ?? fallback.name;
    this.initialReason = initialReason ?? null;
  }

  get lastUsage(): LlmCallReceipt | null {
    return this.primary?.lastUsage ?? null;
  }

  get lastFallback(): LlmFallbackNotice | null {
    return this.fallbackNotice;
  }

  suggestFollowup(input: {
    customerId: string;
    shipment: SampleShipment;
    tracking: TrackingSnapshot;
  }): Promise<FollowupSuggestion> {
    return this.attempt(
      "FOLLOWUP_SUGGESTION",
      () => this.primary!.suggestFollowup(input),
      () => this.fallback.suggestFollowup(input),
    );
  }

  classifyReply(input: { text: string }): Promise<ReplyClassification> {
    return this.attempt(
      "REPLY_CLASSIFICATION",
      () => this.primary!.classifyReply(input),
      () => this.fallback.classifyReply(input),
    );
  }

  extractQuoteIntent(input: { text: string }): Promise<QuoteIntentExtraction> {
    return this.attempt(
      "QUOTE_INTENT",
      () => this.primary!.extractQuoteIntent(input),
      () => this.fallback.extractQuoteIntent(input),
    );
  }

  extractReplyFromImage(input: { imageUrl: string }): Promise<{ text: string }> {
    return this.attempt(
      "SCREENSHOT_OCR",
      () => this.primary!.extractReplyFromImage(input),
      () => this.fallback.extractReplyFromImage(input),
    );
  }

  private async attempt<T>(
    task: LlmTask,
    runPrimary: () => Promise<T>,
    runFallback: () => Promise<T>,
  ): Promise<T> {
    if (!this.primary) {
      this.fallbackNotice = { task, reason: this.initialReason ?? "模型服务未配置" };
      return runFallback();
    }
    try {
      return await runPrimary();
    } catch (error) {
      // 记下第一次失败原因；同一次请求里后续任务继续用主 provider，仍是同一套降级策略。
      this.fallbackNotice ??= { task, reason: humanizeLlmError(error) };
      return runFallback();
    }
  }
}

/** 多模态消息内容：文本或图片（OpenAI 兼容 image_url 协议）。 */
export type ChatContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

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
      new Error(
        "截图识别需要真实视觉模型：请配置 openai-compatible 企业模型网关与 LLM_VISION_MODEL 后重试。",
      ),
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

export interface OpenAiCompatibleOptions {
  settings: ResolvedLlmSettings;
  usage: LlmUsageSink;
  apiKey: string;
  timeoutMs: number;
  /** 截图识别专用视觉模型 ID，来自 LLM_VISION_MODEL；不在 provider 内固定。 */
  visionModel: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * 通用 OpenAI 兼容企业网关 provider。
 *
 * - 只请求 `${settings.baseUrl}/chat/completions`，不直连任何上游模型厂商。
 * - 网关令牌由 `settings.keyRef` 指向的受控环境变量解析；Key 不进日志、不落库。
 * - `request_id` 随请求头下发，响应 usage 幂等写 `token_usage`。
 * - 出网前统一脱敏；prompt 只落 SHA-256。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible";
  private usage: LlmCallReceipt | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: OpenAiCompatibleOptions) {
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
      this.options.visionModel,
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
    const baseUrl = settings.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("未配置 LLM_BASE_URL：请配置 openai-compatible 企业模型网关地址后重试。");
    }
    // 按任务路由：截图识别走 LLM_VISION_MODEL；复杂报价/对账走 reasoningModel。
    const promptChars = messageText(messages).length;
    const model =
      task === "SCREENSHOT_OCR"
        ? this.options.visionModel
        : task === "QUOTE_DRAFT" || (task === "QUOTE_INTENT" && promptChars > 1200)
          ? settings.reasoningModel
          : fallbackModel;
    if (!model) {
      throw new Error(
        task === "SCREENSHOT_OCR"
          ? "未配置 LLM_VISION_MODEL：请配置 openai-compatible 企业模型网关的视觉模型后重试。"
          : "未配置模型 ID：请配置 openai-compatible 企业模型网关的 LLM_DEFAULT_MODEL / LLM_REASONING_MODEL 后重试。",
      );
    }
    if (!settings.modelAllowlist.includes(model)) {
      throw new Error(
        task === "SCREENSHOT_OCR"
          ? `截图识别需要视觉模型 ${model}，但它不在当前模型白名单内；请把 LLM_VISION_MODEL 加入 LLM_MODEL_ALLOWLIST 后重试。`
          : `模型 ${model} 不在租户白名单内`,
      );
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
      response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
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
      throw new Error(`企业模型网关调用失败：HTTP ${response.status} ${body.slice(0, 300)}`);
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
      throw new Error("企业模型网关返回为空：缺少 choices[0].message.content");
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
    .map((part) => (part.type === "text" ? `text:${part.text}` : `image_url:${part.image_url.url}`))
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
  /** 直接透传 loadEnv() 的结果；字段可选，便于测试构造最小环境。 */
  env?: {
    NODE_ENV?: "development" | "test" | "production";
    AUTH_MODE?: "dev" | "oidc";
    LLM_BASE_URL?: string;
    LLM_API_KEY?: string;
    LLM_TIMEOUT_MS?: number;
    LLM_VISION_MODEL?: string;
  };
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * 密钥引用白名单（与控制面 `apps/platform-api/src/control/settings.service.ts` 同规则）：
 * 只接受 `LLM_API_KEY` / `LLM_TENANT_KEY_<名称>`（名称可含下划线分段）。
 * 两包不共享源码，改这里必须同步控制面那份。
 */
const LLM_KEY_REF_PATTERN = /^LLM_(?:API_KEY|TENANT_KEY(?:_[A-Za-z0-9]+)+)$/;

export function isAllowedLlmKeyRef(name: string): boolean {
  return LLM_KEY_REF_PATTERN.test(name);
}

/** 按配置创建 LLM provider；未知实现显式报错，不静默降级。 */
export function createLlmProvider(
  provider = "local-rule",
  options?: CreateLlmOptions,
): LlmProvider {
  if (provider === "local-rule") return new LocalRuleLlmProvider();
  if (provider === "openai-compatible") {
    if (!options) {
      throw new Error("LLM_PROVIDER=openai-compatible 需要 settings / usage 配置");
    }
    // 生产态判定统一走 isProductionLike（NODE_ENV=production 或 AUTH_MODE=oidc），
    // 避免 OIDC 已接入但 NODE_ENV 不是 production 时 fail-open（WAN-94）。
    const productionLike = isProductionLike({ ...process.env, ...options.env });

    const baseUrl =
      options.settings.baseUrl || options.env?.LLM_BASE_URL || process.env.LLM_BASE_URL;
    if (!baseUrl) {
      throw new Error(
        "缺少 LLM_BASE_URL：请配置 openai-compatible 企业模型网关地址（含 /v1）后再调用模型。",
      );
    }

    const explicitKeyRef = options.settings.keyRef;
    const keyRef = explicitKeyRef ?? "LLM_API_KEY";
    // 白名单外的引用名（如 DATABASE_URL）绝不读取：先判后读，禁止 process.env[用户输入]。
    if (!isAllowedLlmKeyRef(keyRef)) {
      if (productionLike) {
        throw new Error(
          `LLM keyRef "${keyRef}" 不在白名单内（只允许 LLM_API_KEY / LLM_TENANT_KEY_<名称>）；请配置 openai-compatible 企业模型网关的合法 Key 引用。`,
        );
      }
      // dev：白名单外的引用视为未配置，回退 LLM_API_KEY。
    }
    const resolvable = isAllowedLlmKeyRef(keyRef) ? keyRef : "LLM_API_KEY";
    const keyFromRef =
      resolvable === "LLM_API_KEY"
        ? (options.env?.LLM_API_KEY ?? process.env.LLM_API_KEY)
        : process.env[resolvable];
    if (!keyFromRef && productionLike) {
      throw new Error(
        `LLM keyRef "${resolvable}" 未命中环境变量/KMS；请配置 openai-compatible 企业模型网关的令牌后再启动。`,
      );
    }
    const apiKey = keyFromRef ?? DEV_LLM_API_KEY;
    if (productionLike && isPlaceholderLlmKey(apiKey)) {
      throw new Error(
        "缺少有效的 LLM_API_KEY：占位 key 不能连接 openai-compatible 企业模型网关，请配置网关令牌。",
      );
    }

    return new OpenAiCompatibleProvider({
      settings: { ...options.settings, baseUrl },
      usage: options.usage,
      apiKey,
      timeoutMs: options.env?.LLM_TIMEOUT_MS ?? 30_000,
      visionModel: options.env?.LLM_VISION_MODEL ?? process.env.LLM_VISION_MODEL ?? "",
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  }
  throw new Error(
    `LLM_PROVIDER=${provider} 不受支持；当前支持：local-rule / openai-compatible。请配置 openai-compatible 企业模型网关。`,
  );
}

/**
 * 产品路径统一用这个工厂，而不是直接 `createLlmProvider`。
 *
 * - `local-rule`：零依赖，直接用。
 * - `openai-compatible`：包一层回退。构造失败（缺 baseUrl / key / 白名单）也**不让整个
 *   请求 500**：降级到本地规则，并把配置原因作为降级说明带回给用户。
 *
 * 这是 WAN-172 的直接修复：生产网关 403 时仍能出草稿，而不是把「模型坏了」变成
 * 「报价功能坏了」。
 */
export function createResilientLlmProvider(
  provider = "local-rule",
  options?: CreateLlmOptions,
): LlmProvider {
  const local = new LocalRuleLlmProvider();
  if (provider === "local-rule") return local;
  try {
    return new FallbackLlmProvider(createLlmProvider(provider, options), local);
  } catch (error) {
    return new FallbackLlmProvider(null, local, humanizeLlmError(error));
  }
}
