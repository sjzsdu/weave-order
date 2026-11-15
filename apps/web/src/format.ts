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
  QUOTE_DRAFT_GENERATED: "生成了报价草稿",
  QUOTE_CONFIRMED: "报价已批准生效",
  QUOTE_REJECTED: "报价被驳回",
  SAMPLE_SHIPMENT_DRAFTED: "生成了寄样单草稿",
  SAMPLE_SHIPMENT_CONFIRMED: "寄样单已确认",
  SAMPLE_SHIPMENT_REJECTED: "寄样单被驳回",
  CUSTOMER_CREATED: "新建了客户",
  SAMPLE_CREATED: "新建了样品",
  REVISION_REQUESTED: "发起了改稿",
  REVISION_RESOLVED: "处理了改稿",
  IMPORT_RESET: "重置了导入数据",
  ORDER_CREATED: "创建了订单",
  ORDER_CONFIRMED: "订单已确认",
  RECEIVABLE_CREATED: "建了应收",
  RECEIVABLE_PAYMENT_RECORDED: "登记了回款",
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
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
