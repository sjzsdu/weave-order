/**
 * 工作台标题文案。
 *
 * 四态由后端计数驱动，按优先级取第一条成立的：
 * 有智能体产出 / 有待办等决定 / 全空新用户 / 有数据但今天没动静。
 *
 * 三条不能破的约束：
 * - 新用户绝不能看到「替你做了」—— 那是把建公司的系统事件当成了业绩。
 * - 有待办不等于没动态：草稿躺在等人决定，那也是小织今天干出来的活。
 *   只要还有待办，就不能说「没有新的智能体动态」，否则同一屏的
 *   「N 件等你决定」会当场打脸，用户会连这台机器说的话一起不信。
 * - 反过来，没做完的事不能算业绩：有待办但今天没有产出时，
 *   也不能说「替你做了」。
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
  // 有待办优先于开张引导：已经在等决定的公司不是刚开张。
  if (pendingCount > 0) return `有 ${pendingCount} 件等你决定`;
  if (isNewWorkspace) return "欢迎，先把客户和样品放进来";
  return "今天没有新的智能体动态";
}
