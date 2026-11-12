import type { KernelContext } from "../kernel";
import type { AuthRequest } from "../auth/auth.guard";

/** 页面上的「让智能体生成报价草稿」按钮：调用方永远是 AGENT。 */
export const AGENT_CONTEXT: KernelContext = {
  actor: { type: "AGENT", id: "quote-agent" },
};

/**
 * 人类确认动作的调用方。
 * 生产环境这里应来自登录态（Casdoor OIDC），MVP 先用固定审批人标识。
 */
export const HUMAN_CONTEXT: KernelContext = {
  actor: { type: "HUMAN", id: "web-approver" },
};

/**
 * 工具调用上下文：带 token 时把「驱动智能体的人」写进审计
 * （actor 仍是 AGENT，因为工具永远代表智能体产出草稿；人只是发起者）。
 */
export function agentContext(request?: AuthRequest): KernelContext {
  if (request?.auth) {
    return { actor: { type: "AGENT", id: `user:${request.auth.user.id}` } };
  }
  return AGENT_CONTEXT;
}

/** 人类写操作上下文：带 token 时审批人就是 token 所属账号；否则退回网页固定审批人。 */
export function humanContext(request?: AuthRequest): KernelContext {
  if (request?.auth) {
    return { actor: { type: "HUMAN", id: `user:${request.auth.user.id}` } };
  }
  return HUMAN_CONTEXT;
}
