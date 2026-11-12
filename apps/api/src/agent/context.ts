import type { Tools } from "../tools";

/**
 * 寄样跟进智能体的身份。
 * 图里的每个节点都只通过 tools 执行动作，actor 固定为 AGENT。
 * 这里不 import kernel（ESLint 边界）：工具调用的上下文是结构化对象。
 */
export const FOLLOWUP_AGENT_CONTEXT = {
  actor: { type: "AGENT" as const, id: "sample-followup-agent" },
};

export type FollowupTools = Tools;

/** 找样 / 报价智能体的身份：同样只通过 tools 动作。 */
export const QUOTING_AGENT_CONTEXT = {
  actor: { type: "AGENT" as const, id: "quoting-agent" },
};
