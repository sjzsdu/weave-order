/**
 * 工作台标题文案。
 *
 * 三态由后端计数驱动：有智能体产出 / 无产出但有待办 / 全空新用户。
 * 新用户绝不能看到「替你做了」—— 那是把建公司的系统事件当成了业绩。
 */
export interface TodayHeadlineInput {
  /** `stats.todayAgentDoneCount`：今天、智能体、业务动作。 */
  agentDone: number;
  /** 待确认单据数（D1 后不再有审批队列）。 */
  pendingCount: number;
  /** 客户与样品都为 0，即还没有任何业务数据。 */
  isNewWorkspace: boolean;
}

export function todayHeadline({
  agentDone,
  pendingCount,
  isNewWorkspace,
}: TodayHeadlineInput): string {
  if (agentDone > 0) return `今天，小织替你做了 ${agentDone} 件事`;
  if (pendingCount > 0) return "今天没有新的智能体动态";
  if (isNewWorkspace) return "欢迎，先把客户和样品放进来";
  return "今天没有新的智能体动态";
}
