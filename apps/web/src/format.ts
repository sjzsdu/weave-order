/** 页面级展示辅助：只做文案与时间格式化，不做金额计算。 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export const ACTION_LABEL: Record<string, string> = {
  // 业务动作（与 api 的动态流白名单一致）
  CUSTOMER_CREATED: "新建了客户",
  CUSTOMER_CONTEXT_UPDATED: "更新了客户背景",
  SAMPLE_CREATED: "新建了样品",
  SAMPLE_UPDATED: "更新了样品",
  SAMPLE_ARCHIVED: "归档了样品",
  SAMPLE_IMAGE_ADDED: "给样品加了图片",
  SAMPLE_INDEX_FAILED: "样品图片索引失败",
  IMPORT_RESET: "重置了导入数据",
  SAMPLE_SHIPMENT_DRAFTED: "生成了寄样单草稿",
  SAMPLE_SHIPMENT_CONFIRMED: "确认了寄样单",
  SAMPLE_SHIPMENT_REJECTED: "驳回了寄样单",
  QUOTE_DRAFT_GENERATED: "生成了报价草稿",
  QUOTE_DRAFT_REVISED: "改了报价草稿",
  QUOTE_REVISION_PROPOSED: "发起了报价改稿",
  QUOTE_APPROVAL_ESCALATED: "把报价升级到上级复核",
  QUOTE_CONFIRMED: "报价已批准生效",
  QUOTE_REJECTED: "报价被驳回",
  REVISION_REQUESTED: "发起了改稿",
  REVISION_RESOLVED: "处理了改稿",
  ORDER_CREATED: "创建了订单",
  ORDER_CONFIRMED: "订单已确认",
  RECEIVABLE_CREATED: "建了应收",
  RECEIVABLE_PAYMENT_RECORDED: "登记了回款",
  QUOTE_SHARE_CREATED: "生成了客户报价链接",
  QUOTE_SHARE_REVOKED: "撤回了客户报价链接",
  // 系统 / 身份 / 运维动作：只在审计页出现，说清楚做了什么
  TENANT_CREATED: "创建了公司",
  TENANT_SWITCHED: "切换了公司",
  MEMBERSHIP_CREATED: "添加了成员",
  MEMBERSHIP_INVITED: "邀请了成员",
  MEMBERSHIP_ACTIVATED: "成员已加入",
  LLM_SETTINGS_UPDATED: "更新了智能体设置",
  PRICING_POLICY_CREATED: "建了报价策略",
  PRICING_POLICY_UPDATED: "更新了报价策略",
  DECISION_DELTA_RECORDED: "记录了决策偏差",
  USER_CREATED: "创建了账号",
  API_TOKEN_CREATED: "创建了接口凭据",
  API_TOKEN_REVOKED: "撤销了接口凭据",
  PRINT_AGENT_REGISTERED: "注册了打印代理",
  PRINT_AGENT_DISABLED: "停用了打印代理",
  PRINT_TEMPLATE_PUBLISHED: "发布了打印模板",
  PRINT_JOB_CREATED: "创建了打印任务",
  PRINT_JOB_COMPLETED: "打印任务已完成",
  PRINT_JOB_FAILED: "打印任务失败",
  PRINT_JOB_CANCELLED: "取消了打印任务",
  PRINT_BOX_CREATED: "创建了箱",
  PRINT_BOX_VOIDED: "作废了箱",
  PRINT_LABEL_REISSUED: "补打了标签",
  PRINT_DISCREPANCY_FLAGGED: "标记了打印差异",
  PRINT_SCAN_RECORDED: "记录了扫码",
};

/** 未映射动作的兜底：绝不把 SCREAMING_SNAKE 枚举直接丢到用户面前。 */
export const UNKNOWN_ACTION_LABEL = "更新了一条记录";

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? UNKNOWN_ACTION_LABEL;
}

export const KIND_LABEL: Record<string, string> = {
  quote: "报价",
  sample_shipment: "寄样",
};

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  SENT: "已发出",
  ACCEPTED: "客户接受",
  REJECTED: "已驳回",
  EXPIRED: "已过期",
  CONFIRMED: "已确认",
  IN_PRODUCTION: "生产中",
  SHIPPED: "已发出",
  DELIVERED: "已签收",
  CANCELLED: "已取消",
  PENDING: "待处理",
  PARTIAL: "部分收款",
  PAID: "已收清",
  OVERDUE: "已逾期",
  COMPLETED: "已完成",
  RECEIVED: "已录入",
};

export const TIER_LABEL: Record<string, string> = {
  VIP: "VIP",
  REGULAR: "常规",
  NEW: "新客",
  COLD: "沉睡",
};

export const TIMELINE_KIND_LABEL: Record<string, string> = {
  quote: "报价",
  sample_shipment: "寄样",
  order: "订单",
  receivable: "回款",
  followup: "跟进",
  inbound_reply: "客户回复",
};

/** 订单状态（合同链路），与 schema 的 OrderStatus 一一对应。 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  CONFIRMED: "已成交",
  IN_PRODUCTION: "生产中",
  SHIPPED: "已发货",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

/** 应收状态：逾期由服务端按到期日派生，前端不改写。 */
export const RECEIVABLE_STATUS_LABEL: Record<string, string> = {
  PENDING: "待收",
  PARTIAL: "部分收款",
  PAID: "已结清",
  OVERDUE: "逾期",
  CANCELLED: "已取消",
};

/**
 * 整数分 → 纯数字元（无币种符号、无千分位），用于 CSV 与打印文本。
 * 用整数除法与补零，不做 `amount / 100` 的浮点格式化。
 */
export function plainCents(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  return `${sign}${Math.trunc(absolute / 100)}.${(absolute % 100).toString().padStart(2, "0")}`;
}
