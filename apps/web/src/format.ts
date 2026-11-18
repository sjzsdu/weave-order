/**
 * 页脚版本号：只在构建期注入了语义化版本时才显示。
 *
 * 注入值缺失、为空、或不是版本号（本地 sha 构建）时返回 null——宁可不显示，
 * 也不给用户一个错的版本号：v0.1.0 写死在代码里，发到 v0.1.8 之后页脚还在说
 * v0.1.0，用户报障时给出的版本就是错的。
 */
export function appVersionLabel(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) return null;
  return `v${value}`;
}

/**
 * 页脚品牌行：有可信版本才写版本，commit 只作为版本的附注。
 * 版本缺失时连「· v」「()」都不留，只剩品牌名——不显示一句错话，也不显示一句废话。
 */
export function footerBrandLabel(version: string | null, commit?: string | null): string {
  const brand = "织序 WeaveOrder";
  if (!version) return brand;
  const sha = (commit ?? "").trim();
  return sha ? `${brand} · ${version} (${sha})` : `${brand} · ${version}`;
}

/** 页面级展示辅助：只做文案与时间格式化，不做金额计算。 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(then).toLocaleDateString("zh-CN");
}

// 审计文案只有一份：定义在 @weave-order/schema，与移动端、审批卡共用。
// 这里保留旧名字，页面代码继续写 `actionLabel(...)` 即可。
export {
  AUDIT_ACTION_LABEL as ACTION_LABEL,
  UNKNOWN_AUDIT_ACTION_LABEL as UNKNOWN_ACTION_LABEL,
  auditActionLabel as actionLabel,
} from "@weave-order/schema";

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

const TECHNICAL_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * 客户负责人的展示文案。
 *
 * 后端已经只返回姓名/邮箱副本，但历史数据与其它域仍可能把 SSO 主键当名字回传；
 * 这里再挡一次：像 UUID 的值一律不显示，改成「我 / 同事 / 未分配」（WAN-151）。
 */
export function ownerLabel(
  ownerName: string | null | undefined,
  ownerId: string | null | undefined,
  myMembershipId?: string | null,
): string {
  const name = ownerName?.trim();
  if (name && !TECHNICAL_ID_PATTERN.test(name)) return name;
  if (!ownerId) return "未分配";
  return myMembershipId && ownerId === myMembershipId ? "我" : "同事";
}
