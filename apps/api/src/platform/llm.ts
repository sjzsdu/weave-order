import { FollowupSuggestion, ReplyClassification } from "@weave-order/schema";
import type { FollowupChannel, SampleShipment, TrackingSnapshot } from "@weave-order/schema";

/**
 * LLM provider 接口。
 *
 * 默认实现 `local-rule` 是确定性的规则引擎：不调用外部模型、不需要 key，
 * 输出结构与真实 LLM 完全一致，因此工具/图/测试都不感知 provider 差异。
 * 接真实模型时实现本接口（例如 OpenAI / 通义），按环境变量切换即可。
 */
export interface LlmProvider {
  readonly name: string;
  suggestFollowup(input: {
    customerId: string;
    shipment: SampleShipment;
    tracking: TrackingSnapshot;
  }): Promise<FollowupSuggestion>;
  classifyReply(input: { text: string }): Promise<ReplyClassification>;
}

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

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地确定性实现：同样的状态输入，永远产出同样的建议。 */
export class LocalRuleLlmProvider implements LlmProvider {
  readonly name = "local-rule-v1";

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
}

/** 按配置创建 LLM provider；未知实现显式报错，不静默降级。 */
export function createLlmProvider(provider = "local-rule"): LlmProvider {
  if (provider === "local-rule") return new LocalRuleLlmProvider();
  throw new Error(
    `LLM_PROVIDER=${provider} 尚未接入；当前支持：local-rule。真实模型请实现 LlmProvider 后在此注册。`,
  );
}
