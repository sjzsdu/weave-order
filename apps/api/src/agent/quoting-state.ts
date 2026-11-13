import { Annotation } from "@langchain/langgraph";
import type {
  Customer,
  ImagePayload,
  LlmCallReceipt,
  MissingField,
  QuoteAgentFailure,
  QuoteDraft,
  QuoteIntentExtraction,
  QuotePricingBasis,
  QuoteSampleCandidate,
  QuotingStage,
} from "@weave-order/schema";

const ALLOWED_TRANSITIONS: Record<QuotingStage, readonly QuotingStage[]> = {
  NEW: ["INTENT_PARSED", "FAILED"],
  INTENT_PARSED: ["SAMPLES_FOUND", "NEEDS_INPUT", "FAILED"],
  SAMPLES_FOUND: ["PRICED", "NEEDS_INPUT", "FAILED"],
  PRICED: ["DRAFTED", "FAILED"],
  DRAFTED: ["DONE", "FAILED"],
  NEEDS_INPUT: ["DONE", "FAILED"],
  DONE: [],
  FAILED: [],
};

export function advanceQuoting(from: QuotingStage, to: QuotingStage): QuotingStage {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(
      `报价 agent 非法状态跳转：${from} -> ${to}（允许：${ALLOWED_TRANSITIONS[from].join(", ") || "无"}）`,
    );
  }
  return to;
}

export function quotingAllowedTransitions(stage: QuotingStage): readonly QuotingStage[] {
  return ALLOWED_TRANSITIONS[stage];
}

export const QuoteAgentState = Annotation.Root({
  threadId: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  rawText: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  customerId: Annotation<string | null>({ reducer: (_p, n) => n, default: () => null }),
  currency: Annotation<"CNY" | "USD" | "EUR" | "HKD">({
    reducer: (_p, n) => n,
    default: () => "CNY",
  }),
  image: Annotation<ImagePayload | null>({ reducer: (_p, n) => n, default: () => null }),
  imageUrl: Annotation<string | null>({ reducer: (_p, n) => n, default: () => null }),
  topK: Annotation<number>({ reducer: (_p, n) => n, default: () => 3 }),
  stage: Annotation<QuotingStage>({ reducer: (_p, n) => n, default: () => "NEW" }),
  intent: Annotation<QuoteIntentExtraction | null>({ reducer: (_p, n) => n, default: () => null }),
  customer: Annotation<Customer | null>({ reducer: (_p, n) => n, default: () => null }),
  candidates: Annotation<QuoteSampleCandidate[]>({ reducer: (_p, n) => n, default: () => [] }),
  selectedSampleId: Annotation<string | null>({ reducer: (_p, n) => n, default: () => null }),
  pricingBasis: Annotation<QuotePricingBasis | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),
  draft: Annotation<QuoteDraft | null>({ reducer: (_p, n) => n, default: () => null }),
  missingFields: Annotation<MissingField[]>({ reducer: (_p, n) => n, default: () => [] }),
  explanation: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  provider: Annotation<string>({ reducer: (_p, n) => n, default: () => "local-rule-v1" }),
  usage: Annotation<LlmCallReceipt | null>({ reducer: (_p, n) => n, default: () => null }),
  failure: Annotation<QuoteAgentFailure | null>({ reducer: (_p, n) => n, default: () => null }),
  steps: Annotation<string[]>({
    reducer: (previous, next) => [...previous, ...next],
    default: () => [],
  }),
});

export type QuoteAgentStateType = typeof QuoteAgentState.State;
export type QuoteAgentUpdate = Partial<QuoteAgentStateType>;
