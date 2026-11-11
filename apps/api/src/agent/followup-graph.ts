import { END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { AgentFailure, RawCustomerReply } from "@weave-order/schema";
import type { LlmProvider } from "../platform/llm";
import type { LogisticsProvider } from "../platform/logistics";
import type { ReplySource } from "../platform/reply-source";
import type { Tools } from "../tools";
import { FOLLOWUP_AGENT_CONTEXT } from "./context";
import { FollowupState, advance } from "./state";
import type { FollowupUpdate } from "./state";

type State = typeof FollowupState.State;

export interface FollowupGraphDeps {
  tools: Tools;
  llm: LlmProvider;
  logistics: LogisticsProvider;
  replySource: ReplySource;
  checkpointer: BaseCheckpointSaver;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 统一失败出口：记录节点、错误码、发生时的状态，然后进入 FAILED。 */
function fail(state: State, node: string, code: string, message: string): FollowupUpdate {
  const failure = AgentFailure.parse({
    node,
    code,
    message: message.slice(0, 500),
    stage: state.stage,
  });
  return {
    stage: advance(state.stage, "FAILED"),
    failure,
    steps: [`${node} ✖ ${code}: ${message}`],
  };
}

/**
 * 寄样跟进智能体：建寄样单 → 追踪物流 → 生成跟进建议 → 等客户回复 → 识别 → 触发报价草稿。
 *
 * 节点只做编排，所有副作用都经过 tools（以及 providers），
 * 任何产出都停在 DRAFT / 建议态，确认永远留给人类。
 */
export function createFollowupGraph(deps: FollowupGraphDeps) {
  const { tools, llm, logistics, replySource } = deps;

  const createShipment = async (state: State): Promise<FollowupUpdate> => {
    try {
      const result = await tools.createSampleShipment.execute(
        {
          customerId: state.customerId,
          items: [
            {
              sampleId: state.sampleId,
              quantity: { value: state.quantityValue, unit: state.quantityUnit },
            },
          ],
          channel: "COURIER",
          carrier: state.carrier,
          trackingNumber: state.trackingNumber,
        },
        FOLLOWUP_AGENT_CONTEXT,
      );
      if (!result.ok) {
        return fail(state, "createShipment", result.error.code, result.error.message);
      }
      return {
        shipment: result.data.shipment,
        stage: advance(state.stage, "SHIPMENT_DRAFTED"),
        steps: [
          `createShipment: T-005 → ${result.data.shipment.id}（${result.data.shipment.status}）`,
        ],
      };
    } catch (error) {
      return fail(state, "createShipment", "TOOL_THREW", messageOf(error));
    }
  };

  const trackLogistics = async (state: State): Promise<FollowupUpdate> => {
    try {
      if (state.stage !== "SHIPMENT_DRAFTED") {
        return fail(
          state,
          "trackLogistics",
          "ILLEGAL_STAGE",
          `期望 SHIPMENT_DRAFTED，实际 ${state.stage}`,
        );
      }
      const snapshot = await logistics.track({
        carrier: state.carrier,
        trackingNumber: state.trackingNumber || state.shipment?.trackingNumber || "",
      });
      return {
        tracking: snapshot,
        stage: advance(state.stage, "TRACKED"),
        steps: [
          `trackLogistics: ${snapshot.status}（${snapshot.provider}，${snapshot.events.length} 条轨迹）`,
        ],
      };
    } catch (error) {
      return fail(state, "trackLogistics", "LOGISTICS_FAILED", messageOf(error));
    }
  };

  const generateFollowup = async (state: State): Promise<FollowupUpdate> => {
    try {
      if (state.stage !== "TRACKED" || !state.shipment || !state.tracking) {
        return fail(
          state,
          "generateFollowup",
          "ILLEGAL_STAGE",
          `期望 TRACKED 且已有寄样单/物流，实际 ${state.stage}`,
        );
      }
      const suggestion = await llm.suggestFollowup({
        customerId: state.customerId,
        shipment: state.shipment,
        tracking: state.tracking,
      });
      return {
        followup: suggestion,
        stage: advance(state.stage, "FOLLOWUP_SUGGESTED"),
        steps: [
          `generateFollowup: ${suggestion.provider} 建议 ${suggestion.channel}，计划 ${suggestion.suggestedAt}`,
        ],
      };
    } catch (error) {
      return fail(state, "generateFollowup", "LLM_FAILED", messageOf(error));
    }
  };

  const markWaiting = (state: State): FollowupUpdate => {
    if (state.stage !== "FOLLOWUP_SUGGESTED") {
      return fail(
        state,
        "markWaiting",
        "ILLEGAL_STAGE",
        `期望 FOLLOWUP_SUGGESTED，实际 ${state.stage}`,
      );
    }
    return {
      stage: advance(state.stage, "WAITING_REPLY"),
      steps: ["markWaiting: 等待客户回复（检查点在此之后）"],
    };
  };

  const awaitReply = async (state: State): Promise<FollowupUpdate> => {
    let reply: RawCustomerReply | null = null;
    try {
      reply = await replySource.fetchLatest({
        customerId: state.customerId,
        shipmentId: state.shipment?.id ?? "",
      });
    } catch (error) {
      return fail(state, "awaitReply", "REPLY_SOURCE_FAILED", messageOf(error));
    }

    if (!reply) {
      // interrupt 会暂停图并持久化检查点；重启后用 Command({resume}) 继续。
      // 注意：这里不能包在 try/catch 里，否则会吞掉 LangGraph 的中断信号。
      const payload = interrupt<unknown, unknown>({
        reason: "WAITING_CUSTOMER_REPLY",
        threadId: state.threadId,
        shipmentId: state.shipment?.id ?? null,
        stage: state.stage,
      });
      try {
        reply = RawCustomerReply.parse(payload);
      } catch (error) {
        return fail(state, "awaitReply", "INVALID_REPLY", messageOf(error));
      }
    }

    if (state.stage !== "WAITING_REPLY") {
      return fail(state, "awaitReply", "ILLEGAL_STAGE", `期望 WAITING_REPLY，实际 ${state.stage}`);
    }
    return {
      reply,
      stage: advance(state.stage, "REPLY_RECEIVED"),
      steps: [`awaitReply: 收到 ${reply.channel} 回复（${reply.id}）`],
    };
  };

  const classifyReply = async (state: State): Promise<FollowupUpdate> => {
    try {
      if (state.stage !== "REPLY_RECEIVED" || !state.reply) {
        return fail(
          state,
          "classifyReply",
          "ILLEGAL_STAGE",
          `期望 REPLY_RECEIVED 且已有回复，实际 ${state.stage}`,
        );
      }
      const classification = await llm.classifyReply({ text: state.reply.text });
      return {
        classification,
        steps: [
          `classifyReply: ${classification.intent}（${classification.confidence}，quoteRequested=${classification.quoteRequested}）`,
        ],
      };
    } catch (error) {
      return fail(state, "classifyReply", "LLM_FAILED", messageOf(error));
    }
  };

  const generateQuoteDraft = async (state: State): Promise<FollowupUpdate> => {
    try {
      if (state.stage !== "REPLY_RECEIVED") {
        return fail(
          state,
          "generateQuoteDraft",
          "ILLEGAL_STAGE",
          `期望 REPLY_RECEIVED，实际 ${state.stage}`,
        );
      }
      const result = await tools.generateQuoteDraft.execute(
        {
          customerId: state.customerId,
          currency: state.currency,
          validityDays: 30,
          remarks: "寄样跟进：客户回复询价，智能体生成报价草稿待人类审批",
          items: [
            {
              fabricSampleId: state.sampleId,
              quantity: { value: state.quantityValue, unit: state.quantityUnit },
              unitPrice: { amount: state.unitPriceAmount, currency: state.currency },
            },
          ],
        },
        FOLLOWUP_AGENT_CONTEXT,
      );
      if (!result.ok) {
        return fail(state, "generateQuoteDraft", result.error.code, result.error.message);
      }
      return {
        quote: result.data.draft,
        stage: advance(state.stage, "QUOTE_DRAFTED"),
        steps: [
          `generateQuoteDraft: T-004 → ${result.data.draft.id}（${result.data.draft.status}，total=${result.data.draft.total.amount} 分）`,
        ],
      };
    } catch (error) {
      return fail(state, "generateQuoteDraft", "TOOL_THREW", messageOf(error));
    }
  };

  const finish = (state: State): FollowupUpdate => {
    try {
      return {
        stage: advance(state.stage, "DONE"),
        steps: ["finish: DONE"],
      };
    } catch (error) {
      return fail(state, "finish", "ILLEGAL_STAGE", messageOf(error));
    }
  };

  const afterNode = (next: string) => (state: State) => (state.stage === "FAILED" ? END : next);

  const afterClassify = (state: State) => {
    if (state.stage === "FAILED") return END;
    return state.classification?.quoteRequested ? "generateQuoteDraft" : "finish";
  };

  return new StateGraph(FollowupState)
    .addNode("createShipment", createShipment)
    .addNode("trackLogistics", trackLogistics)
    .addNode("generateFollowup", generateFollowup)
    .addNode("markWaiting", markWaiting)
    .addNode("awaitReply", awaitReply)
    .addNode("classifyReply", classifyReply)
    .addNode("generateQuoteDraft", generateQuoteDraft)
    .addNode("finish", finish)
    .addEdge(START, "createShipment")
    .addConditionalEdges("createShipment", afterNode("trackLogistics"), ["trackLogistics", END])
    .addConditionalEdges("trackLogistics", afterNode("generateFollowup"), ["generateFollowup", END])
    .addConditionalEdges("generateFollowup", afterNode("markWaiting"), ["markWaiting", END])
    .addConditionalEdges("markWaiting", afterNode("awaitReply"), ["awaitReply", END])
    .addConditionalEdges("awaitReply", afterNode("classifyReply"), ["classifyReply", END])
    .addConditionalEdges("classifyReply", afterClassify, ["generateQuoteDraft", "finish", END])
    .addConditionalEdges("generateQuoteDraft", afterNode("finish"), ["finish", END])
    .addEdge("finish", END)
    .compile({ checkpointer: deps.checkpointer });
}

export type FollowupGraph = ReturnType<typeof createFollowupGraph>;
