import { Annotation } from "@langchain/langgraph";
import type {
  AgentFailure,
  Currency,
  FollowupSuggestion,
  QuoteDraft,
  RawCustomerReply,
  ReplyClassification,
  SampleShipment,
  TrackingSnapshot,
  Unit,
} from "@weave-order/schema";
import type { AgentStage } from "@weave-order/schema";

/**
 * 智能体状态机。
 *
 * 图里的每个节点只能沿这些边前进；非法跳转直接抛错（单元测试覆盖），
 * 不允许「跳过物流直接报价」这类状态被静默写进检查点。
 */
const ALLOWED_TRANSITIONS: Record<AgentStage, readonly AgentStage[]> = {
  NEW: ["SHIPMENT_DRAFTED", "FAILED"],
  SHIPMENT_DRAFTED: ["TRACKED", "FAILED"],
  TRACKED: ["FOLLOWUP_SUGGESTED", "FAILED"],
  FOLLOWUP_SUGGESTED: ["WAITING_REPLY", "FAILED"],
  WAITING_REPLY: ["REPLY_RECEIVED", "FAILED"],
  REPLY_RECEIVED: ["QUOTE_DRAFTED", "DONE", "FAILED"],
  QUOTE_DRAFTED: ["DONE", "FAILED"],
  DONE: [],
  FAILED: [],
};

export function allowedTransitions(stage: AgentStage): readonly AgentStage[] {
  return ALLOWED_TRANSITIONS[stage];
}

/** 非法跳转直接抛错：宁可失败，也不让状态机悄悄漂移。 */
export function assertTransition(from: AgentStage, to: AgentStage): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(
      `非法状态跳转：${from} -> ${to}（允许：${ALLOWED_TRANSITIONS[from].join(", ") || "无"}）`,
    );
  }
}

export function advance(from: AgentStage, to: AgentStage): AgentStage {
  assertTransition(from, to);
  return to;
}

/** LangGraph 状态注解：所有节点共享这一份结构，检查点里存的就是它。 */
export const FollowupState = Annotation.Root({
  threadId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  customerId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  sampleId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  quantityValue: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 100,
  }),
  quantityUnit: Annotation<Unit>({
    reducer: (_previous, next) => next,
    default: () => "meter",
  }),
  carrier: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "顺丰",
  }),
  trackingNumber: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  unitPriceAmount: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 1500,
  }),
  currency: Annotation<Currency>({
    reducer: (_previous, next) => next,
    default: () => "CNY",
  }),
  stage: Annotation<AgentStage>({
    reducer: (_previous, next) => next,
    default: () => "NEW",
  }),
  shipment: Annotation<SampleShipment | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  tracking: Annotation<TrackingSnapshot | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  followup: Annotation<FollowupSuggestion | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  reply: Annotation<RawCustomerReply | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  classification: Annotation<ReplyClassification | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  quote: Annotation<QuoteDraft | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  failure: Annotation<AgentFailure | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  /** 每一步的人类可读轨迹，用于 demo 与排障。 */
  steps: Annotation<string[]>({
    reducer: (previous, next) => [...previous, ...next],
    default: () => [],
  }),
});

export type FollowupStateType = typeof FollowupState.State;
export type FollowupUpdate = Partial<FollowupStateType>;
