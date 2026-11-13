import type { KernelContext } from "../kernel";
import type { AuthRequest } from "../auth/auth.guard";

/** 页面上的「让智能体生成报价草稿」按钮：调用方永远是 AGENT。 */
export const AGENT_CONTEXT: KernelContext = {
  actor: { type: "AGENT", id: "quote-agent" },
};

/*
 * 人类动作没有静态上下文。
 * 审批 / 改稿 / 导入等 HUMAN 写路由一律经 `HumanActorService`：
 * 生产态从 OIDC membership 注入真实 actor.id 与 role，缺令牌直接 401；
 * 仅本地/测试在无令牌时回退 `DEV_HUMAN_CONTEXT`（见 human-actor.service.ts）。
 */
