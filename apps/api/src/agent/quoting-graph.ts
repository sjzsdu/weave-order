import { END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { QuoteAgentResult, QuoteRequestInput, weightLabel } from "@weave-order/schema";
import type {
  MissingField,
  QuoteAgentResult as Result,
  QuoteIntentSlots,
  QuoteSampleCandidate,
  WeightMeasurement,
} from "@weave-order/schema";
import type { LlmProvider } from "../platform/llm";
import type { Tools } from "../tools";
import { QUOTING_AGENT_CONTEXT } from "./context";
import type { AgentRunContext } from "./context";
import { QuoteAgentState, advanceQuoting } from "./quoting-state";
import type { QuoteAgentStateType, QuoteAgentUpdate } from "./quoting-state";

type State = QuoteAgentStateType;

export interface QuoteAgentGraphDeps {
  tools: Tools;
  llm: LlmProvider;
  checkpointer: BaseCheckpointSaver;
  /**
   * 这次运行的身份。HTTP 路径必须带驱动者的数据范围——智能体只是执行体，
   * 不能替调用者放大可见客户。默认值是纯 agent 身份（无范围），只用于 demo / 测试。
   */
  ctx?: AgentRunContext;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(state: State, node: string, code: string, message: string): QuoteAgentUpdate {
  return {
    stage: advanceQuoting(state.stage, "FAILED"),
    failure: { node, code, message: message.slice(0, 500), stage: state.stage },
    steps: [`${node} ✖ ${code}: ${message}`],
  };
}

const MISSING_DEFS: Record<MissingField["code"], Omit<MissingField, "code">> = {
  CUSTOMER: {
    label: "客户",
    prompt: "请选择这条询价属于哪个客户",
    blocking: true,
  },
  SAMPLE: {
    label: "样品",
    prompt: "没有匹配到样品，请提供品名/成分/克重或上传图片",
    blocking: true,
  },
  QUANTITY: {
    label: "数量",
    prompt: "请补充采购数量（如 500 米）",
    blocking: true,
  },
  COMPOSITION: {
    label: "成分",
    prompt: "建议补充面料成分，找样会更准",
    blocking: false,
  },
  WEIGHT: {
    label: "克重",
    prompt: "建议补充克重（如 220g/m2）",
    blocking: false,
  },
  PRICE: {
    label: "定价依据",
    prompt: "样品缺少成本底线或币种不一致，无法计算建议价",
    blocking: true,
  },
  CURRENCY: {
    label: "币种",
    prompt: "请确认报价币种",
    blocking: false,
  },
};

function missing(code: MissingField["code"]): MissingField {
  return { code, ...MISSING_DEFS[code] };
}

function dedupeMissing(fields: MissingField[]): MissingField[] {
  const byCode = new Map<MissingField["code"], MissingField>();
  for (const field of fields) byCode.set(field.code, field);
  return Array.from(byCode.values());
}

const MATCH_LABELS: Record<string, string> = {
  code: "样品编号",
  name: "品名",
  composition: "成分",
  weight: "克重",
  image: "图片相似度",
};

function candidateRationale(match: {
  sample: {
    code: string;
    name: string;
    composition: string | null;
    weight: WeightMeasurement | null;
  };
  score: number;
  matchedOn: string[];
}): string {
  const reasons = match.matchedOn.map((field) => MATCH_LABELS[field] ?? field).join("、");
  const spec = [match.sample.composition, weightLabel(match.sample.weight)]
    .filter(Boolean)
    .join(" / ");
  return `${match.sample.code} ${match.sample.name}${spec ? `（${spec}）` : ""}：命中${reasons || "近似"}，相关度 ${(match.score * 100).toFixed(0)}%`;
}

function buildSearchTerms(slots: QuoteIntentSlots, rawText: string): string[] {
  const terms = [
    slots.composition,
    slots.weight,
    ...slots.productKeywords,
    rawText.slice(0, 60).trim(),
  ].filter((term): term is string => typeof term === "string" && term.trim().length >= 2);
  return Array.from(new Set(terms.map((term) => term.trim()))).slice(0, 4);
}

/**
 * 找样 / 报价智能体。
 *
 * 客户原话 → 槽位 → 候选样品（带确定性命中理由）→ 内核定价 → 报价 DRAFT。
 * 节点只调 tools；金额由内核计算；缺什么就明确列出来，不猜、不编。
 */
export function createQuoteAgentGraph(deps: QuoteAgentGraphDeps) {
  const { tools, llm, checkpointer, ctx = QUOTING_AGENT_CONTEXT } = deps;

  const parseIntent = async (state: State): Promise<QuoteAgentUpdate> => {
    let input;
    try {
      input = QuoteRequestInput.parse({
        threadId: state.threadId || undefined,
        rawText: state.rawText,
        customerId: state.customerId ?? undefined,
        currency: state.currency,
        image: state.image ?? undefined,
        imageUrl: state.imageUrl ?? undefined,
        topK: state.topK,
      });
    } catch (error) {
      return fail(state, "parseIntent", "INVALID_INPUT", messageOf(error));
    }

    try {
      const intent = await llm.extractQuoteIntent({ text: input.rawText });
      const fallback = llm.lastFallback ?? null;
      return {
        intent,
        provider: intent.provider,
        usage: llm.lastUsage,
        // 降级事实必须跟着结果走：用户看到的是「报价出来了 + 模型暂时降级」，
        // 而不是一个静默的假成功。
        notice: fallback ? `本次已用本地规则整理：${fallback.reason}。` : null,
        stage: advanceQuoting(state.stage, "INTENT_PARSED"),
        steps: [
          `parseIntent: ${intent.provider} 抽取槽位（成分=${intent.slots.composition ?? "-"}，克重=${intent.slots.weight ?? "-"}，数量=${intent.slots.quantity ? `${intent.slots.quantity.value}${intent.slots.quantity.unit}` : "-"}）`,
          ...(fallback ? [`parseIntent: 已回退本地规则（${fallback.reason}）`] : []),
        ],
      };
    } catch (error) {
      return fail(state, "parseIntent", "LLM_FAILED", messageOf(error));
    }
  };

  const loadCustomer = async (state: State): Promise<QuoteAgentUpdate> => {
    if (!state.customerId) {
      return {
        missingFields: [missing("CUSTOMER")],
        steps: ["loadCustomer: 未选择客户（列为缺失项，不猜客户）"],
      };
    }
    try {
      const result = await tools.getCustomerHistory.execute(
        { customerId: state.customerId, limit: 5 },
        ctx,
      );
      if (!result.ok) {
        if (result.error.code === "CUSTOMER_NOT_FOUND") {
          return {
            missingFields: [missing("CUSTOMER")],
            steps: ["loadCustomer: 客户不存在（列为缺失项）"],
          };
        }
        return fail(state, "loadCustomer", result.error.code, result.error.message);
      }
      return {
        customer: result.data.customer,
        steps: [
          `loadCustomer: ${result.data.customer.code}（${result.data.customer.tier}），历史报价 ${result.data.recentQuotes.length} 条`,
        ],
      };
    } catch (error) {
      return fail(state, "loadCustomer", "TOOL_THREW", messageOf(error));
    }
  };

  const findCandidates = async (state: State): Promise<QuoteAgentUpdate> => {
    const slots = state.intent?.slots;
    if (!slots) {
      return fail(state, "findCandidates", "ILLEGAL_STAGE", "缺少意图槽位");
    }
    const merged = new Map<string, { candidate: QuoteSampleCandidate; matched: Set<string> }>();
    const terms = buildSearchTerms(slots, state.rawText);

    for (const term of terms) {
      try {
        const result = await tools.searchFabricBySpec.execute({ query: term, limit: 20 }, ctx);
        if (!result.ok) {
          return fail(state, "findCandidates", result.error.code, result.error.message);
        }
        for (const match of result.data.matches) {
          const existing = merged.get(match.sample.id);
          const matched = new Set([...(existing?.matched ?? []), ...match.matchedOn]);
          const score = Math.max(existing?.candidate.score ?? 0, match.score);
          merged.set(match.sample.id, {
            matched,
            candidate: {
              sample: match.sample,
              score,
              matchedOn: Array.from(matched),
              source: "SPEC",
              rationale: candidateRationale({ ...match, score, matchedOn: Array.from(matched) }),
            },
          });
        }
      } catch (error) {
        return fail(state, "findCandidates", "TOOL_THREW", messageOf(error));
      }
    }

    if (state.image || state.imageUrl) {
      try {
        const result = await tools.searchFabricByImage.execute(
          state.imageUrl
            ? { imageUrl: state.imageUrl, topK: state.topK, minSimilarity: 0.3 }
            : { image: state.image, topK: state.topK, minSimilarity: 0.3 },
          ctx,
        );
        if (!result.ok) {
          return fail(state, "findCandidates", result.error.code, result.error.message);
        }
        for (const match of result.data.matches) {
          const existing = merged.get(match.sample.id);
          const matched = new Set([...(existing?.matched ?? []), "image"]);
          const score = Math.max(existing?.candidate.score ?? 0, match.score);
          merged.set(match.sample.id, {
            matched,
            candidate: {
              sample: match.sample,
              score,
              matchedOn: Array.from(matched),
              source: existing ? "COMBINED" : "IMAGE",
              rationale: candidateRationale({ ...match, score, matchedOn: Array.from(matched) }),
            },
          });
        }
      } catch (error) {
        return fail(state, "findCandidates", "TOOL_THREW", messageOf(error));
      }
    }

    const ranked = Array.from(merged.values())
      .map((entry) => entry.candidate)
      .sort((a, b) => b.score - a.score || a.sample.code.localeCompare(b.sample.code))
      .slice(0, Math.max(3, state.topK));

    const missingNow: MissingField[] = [];
    if (ranked.length === 0) missingNow.push(missing("SAMPLE"));
    if (!slots.composition) missingNow.push(missing("COMPOSITION"));
    if (!slots.weight) missingNow.push(missing("WEIGHT"));

    return {
      candidates: ranked,
      selectedSampleId: ranked[0]?.sample.id ?? null,
      missingFields: dedupeMissing([...state.missingFields, ...missingNow]),
      stage: advanceQuoting(state.stage, "SAMPLES_FOUND"),
      steps: [
        `findCandidates: ${ranked.length} 个候选（${terms.join(" / ") || "无关键词"}）${ranked[0] ? `，首选 ${ranked[0].sample.code}` : ""}`,
      ],
    };
  };

  const price = async (state: State): Promise<QuoteAgentUpdate> => {
    const quantity = state.intent?.slots.quantity ?? null;
    const missingNow: MissingField[] = [];

    if (!state.customer) missingNow.push(missing("CUSTOMER"));
    if (!quantity) missingNow.push(missing("QUANTITY"));
    if (!state.selectedSampleId) missingNow.push(missing("SAMPLE"));

    const merged = dedupeMissing([...state.missingFields, ...missingNow]);
    if (merged.some((field) => field.blocking)) {
      return {
        missingFields: merged,
        stage: advanceQuoting(state.stage, "NEEDS_INPUT"),
        steps: [
          `price: 无法定价（缺失：${merged
            .filter((field) => field.blocking)
            .map((field) => field.label)
            .join("、")}）`,
        ],
      };
    }
    if (!state.customerId || !state.selectedSampleId || !quantity) {
      throw new Error("定价前置校验与 TypeScript 收窄不一致");
    }

    try {
      const result = await tools.suggestLinePrice.execute(
        {
          customerId: state.customerId,
          fabricSampleId: state.selectedSampleId,
          quantity,
          currency: state.currency,
        },
        ctx,
      );
      if (!result.ok) {
        if (result.error.code === "KERNEL_REJECTED") {
          return {
            missingFields: dedupeMissing([...merged, missing("PRICE")]),
            stage: advanceQuoting(state.stage, "NEEDS_INPUT"),
            steps: [`price: 内核拒绝定价（${result.error.reason}）`],
          };
        }
        return fail(state, "price", result.error.code, result.error.message);
      }
      return {
        pricingBasis: result.data.pricing,
        missingFields: merged,
        stage: advanceQuoting(state.stage, "PRICED"),
        steps: [
          `price: ${result.data.pricing.suggestedUnitPrice.amount} 分 / ${quantity.unit}（成本底线+等级加价，内核计算）`,
        ],
      };
    } catch (error) {
      return fail(state, "price", "TOOL_THREW", messageOf(error));
    }
  };

  const generateDraft = async (state: State): Promise<QuoteAgentUpdate> => {
    const quantity = state.intent?.slots.quantity;
    if (!state.customerId || !state.selectedSampleId || !quantity || !state.pricingBasis) {
      return fail(state, "generateDraft", "ILLEGAL_STAGE", "定价结果不完整，拒绝生成半成品草稿");
    }
    try {
      const result = await tools.generateQuoteDraft.execute(
        {
          customerId: state.customerId,
          currency: state.currency,
          validityDays: 30,
          remarks: "智能体按客户原话生成草稿：定价依据来自内核，等待人类审批",
          items: [
            {
              fabricSampleId: state.selectedSampleId,
              quantity,
              unitPrice: state.pricingBasis.suggestedUnitPrice,
            },
          ],
        },
        ctx,
      );
      if (!result.ok) {
        return fail(state, "generateDraft", result.error.code, result.error.message);
      }
      return {
        draft: result.data.draft,
        stage: advanceQuoting(state.stage, "DRAFTED"),
        steps: [
          `generateDraft: T-004 → ${result.data.draft.id}（${result.data.draft.status}，total=${result.data.draft.total.amount} 分）`,
        ],
      };
    } catch (error) {
      return fail(state, "generateDraft", "TOOL_THREW", messageOf(error));
    }
  };

  const finalize = (state: State): QuoteAgentUpdate => {
    const missingText = state.missingFields.length
      ? `缺失项：${state.missingFields.map((field) => field.label).join("、")}。`
      : "";
    const draftText = state.draft
      ? `已生成报价草稿 ${state.draft.id.slice(0, 8)}（DRAFT，总额 ${(state.draft.total.amount / 100).toFixed(2)} ${state.draft.currency}），等待人类审批。`
      : "暂未生成草稿：补齐阻断项后可再次发起。";
    return {
      stage: advanceQuoting(state.stage, "DONE"),
      explanation: `${state.notice ? `${state.notice} ` : ""}${draftText} 候选样品 ${state.candidates.length} 个。${missingText}`,
      steps: ["finalize: DONE"],
    };
  };

  const afterParse = (state: State) => (state.stage === "FAILED" ? END : "loadCustomer");
  const afterLoad = (state: State) => (state.stage === "FAILED" ? END : "findCandidates");
  const afterFind = (state: State) => (state.stage === "FAILED" ? END : "price");
  const afterPrice = (state: State) => {
    if (state.stage === "FAILED") return END;
    return state.stage === "PRICED" ? "generateDraft" : "finalize";
  };

  return new StateGraph(QuoteAgentState)
    .addNode("parseIntent", parseIntent)
    .addNode("loadCustomer", loadCustomer)
    .addNode("findCandidates", findCandidates)
    .addNode("price", price)
    .addNode("generateDraft", generateDraft)
    .addNode("finalize", finalize)
    .addEdge(START, "parseIntent")
    .addConditionalEdges("parseIntent", afterParse, ["loadCustomer", END])
    .addConditionalEdges("loadCustomer", afterLoad, ["findCandidates", END])
    .addConditionalEdges("findCandidates", afterFind, ["price", END])
    .addConditionalEdges("price", afterPrice, ["generateDraft", "finalize", END])
    .addConditionalEdges(
      "generateDraft",
      (state) => (state.stage === "FAILED" ? END : "finalize"),
      ["finalize", END],
    )
    .addEdge("finalize", END)
    .compile({ checkpointer });
}

export type QuoteAgentGraph = ReturnType<typeof createQuoteAgentGraph>;

/** 把图状态收敛成对外契约（缺字段优先于「看起来成功」）。 */
export function toQuoteAgentResult(state: QuoteAgentStateType): Result {
  const status = state.failure ? "FAILED" : state.draft ? "DRAFTED" : "NEEDS_INPUT";
  return QuoteAgentResult.parse({
    threadId: state.threadId,
    stage: state.stage,
    status,
    intent: state.intent,
    candidates: state.candidates,
    selectedSampleId: state.selectedSampleId,
    pricingBasis: state.pricingBasis,
    draft: state.draft,
    missingFields: state.missingFields,
    explanation: state.explanation,
    notice: state.notice,
    provider: state.provider,
    usage: state.usage,
    failure: state.failure,
  });
}
