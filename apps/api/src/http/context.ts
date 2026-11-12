import type { KernelContext } from "../kernel";

/** 页面上的「让智能体生成报价草稿」按钮：调用方永远是 AGENT。 */
export const AGENT_CONTEXT: KernelContext = {
  actor: { type: "AGENT", id: "quote-agent" },
};

/**
 * 人类确认动作的调用方。
 * 生产环境这里应来自登录态（Casdoor OIDC），MVP 先用固定审批人标识。
 */
export const HUMAN_CONTEXT: KernelContext = {
  // 本地/演示环境没有网关登录态：固定为 owner。生产必须从 RequestContext 注入真实角色。
  actor: { type: "HUMAN", id: "web-approver", role: "OWNER" },
};
