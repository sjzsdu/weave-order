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
  RecordTokenUsageInput,
  ResolvedLlmSettings,
  SampleShipment,
  TrackingSnapshot,
} from "@weave-order/schema";
import { redactSensitiveText } from "./privacy";

/** 用量写入端口：由 kernel.usage 实现，platform 不直接碰数据库。 */
export interface LlmUsageSink {
  record(input: RecordTokenUsageInput): Promise<{ inserted: boolean }>;
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
  /** 最近一次真实模型调用的用量回执；本地规则实现为 null。 */
  readonly lastUsage: LlmCallReceipt | null;
}

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

  private async chat(
    task: LlmTask,
    messages: { role: "system" | "user"; content: string }[],
    fallbackModel: string,
  ): Promise<string> {
    const settings = this.options.settings;
    // 按任务路由：复杂报价/对账用 reasoner；超长意图（客户原话很长）也升到 reasoner。
    const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    const model =
      task === "QUOTE_DRAFT" || (task === "QUOTE_INTENT" && promptChars > 1200)
        ? settings.reasoningModel
        : fallbackModel;
    if (!settings.modelAllowlist.includes(model)) {
      throw new Error(`模型 ${model} 不在租户白名单内`);
    }
    const budget = await this.options.usage.budgetStatus(
      settings.dailyTokenBudget,
      settings.monthlyTokenBudget,
    );
    if (budget.dailyExceeded || budget.monthlyExceeded) {
      throw new Error(
        `LLM 预算已用尽（daily=${budget.dailyTokens}/${budget.dailyBudget ?? "∞"}，monthly=${budget.monthlyTokens}/${budget.monthlyBudget ?? "∞"}）`,
      );
    }

    const requestId = randomUUID();
    const redactedMessages = messages.map((message) => ({
      ...message,
      content: redactSensitiveText(message.content),
    }));
    const promptHash = createHash("sha256")
      .update(redactedMessages.map((message) => `${message.role}:${message.content}`).join("\n"))
      .digest("hex");

    const response = await this.fetchImpl(
      `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
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
          ...settings.params,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LiteLLM 调用失败：HTTP ${response.status} ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as ChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("LiteLLM 返回为空：缺少 choices[0].message.content");

    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;
    const cachedTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const recorded = await this.options.usage.record({
      requestId,
      task,
      model: payload.model ?? model,
      provider: this.name,
      promptTokens,
      completionTokens,
      cachedTokens,
      costMicros: null,
      promptHash,
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
    void recorded;
    return content;
  }
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

/** 按配置创建 LLM provider；未知实现显式报错，不静默降级。 */
export function createLlmProvider(
  provider = "local-rule",
  options?: CreateLlmOptions,
): LlmProvider {
  if (provider === "local-rule") return new LocalRuleLlmProvider();
  if (provider === "litellm") {
    if (!options) throw new Error("LLM_PROVIDER=litellm 需要 settings / usage 配置");
    const keyRef = options.settings.keyRef;
    const referenced = keyRef === "LITELLM_MASTER_KEY" ? undefined : keyRef;
    const keyFromRef = referenced ? process.env[referenced] : undefined;
    const keyFromMaster = options.env?.LITELLM_MASTER_KEY ?? process.env.LITELLM_MASTER_KEY;
    if (referenced && !keyFromRef && options.env?.NODE_ENV === "production") {
      throw new Error(
        `LLM keyRef "${referenced}" 未命中环境变量/KMS；生产环境拒绝启动，请配置该密钥或修正 llm_settings.key_ref`,
      );
    }
    const apiKey =
      keyFromRef ?? keyFromMaster ?? (options.env?.NODE_ENV === "production" ? "" : "sk-local-dev");
    if (!apiKey || (options.env?.NODE_ENV === "production" && apiKey === "sk-local-dev")) {
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
