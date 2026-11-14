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
};
