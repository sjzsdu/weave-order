/** 金额/百分比/状态格式化；所有金额输入都是整数分。 */
export function money(cents: number, currency = "CNY"): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents) / 100;
  const formatted = absolute.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol =
    currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency === "HKD" ? "HK$" : "€";
  return `${sign}${symbol}${formatted}`;
}

export function wan(cents: number): string {
  return `¥${(cents / 1_000_000).toFixed(1)} 万`;
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function bps(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

/**
 * 管理端统一展示时区。
 *
 * 这些格式化函数既在服务端组件里跑（Node 进程默认 UTC），也在客户端组件里跑
 * （浏览器本地时区），不显式指定 timeZone 时两边结果会差 8 小时。运营只在国内，
 * 统一按北京时间展示；将来若有海外运营，再改成按用户时区在客户端格式化。
 */
export const ADMIN_TIME_ZONE = "Asia/Shanghai";
export const ADMIN_TIME_ZONE_LABEL = "北京时间（UTC+8）";

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function date(value: string | null | undefined): string {
  const parsed = parse(value);
  if (!parsed) return "—";
  return parsed.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: ADMIN_TIME_ZONE,
  });
}

export function day(value: string | null | undefined): string {
  const parsed = parse(value);
  if (!parsed) return "—";
  return parsed.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: ADMIN_TIME_ZONE,
  });
}

/** 北京时间下的当月区间（YYYY-MM-DD），避免月初/月末在 UTC 与本地时区之间错位。 */
export function currentMonthRange(now = new Date()): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ADMIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(lastDay).padStart(2, "0")}` };
}

export const TENANT_STATUS_LABEL: Record<string, string> = {
  TRIAL: "试用",
  ACTIVE: "正式",
  OVERDUE: "逾期",
  SUSPENDED: "已暂停",
  CANCELLED: "已注销",
};

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  ISSUED: "已开具",
  PAID: "已回款",
  OVERDUE: "逾期",
  VOID: "已作废",
  RED_FLUSH: "已红冲",
};

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  PENDING: "待复核",
  APPROVED: "已通过",
  REJECTED: "已拒绝",
  EXPIRED: "已过期",
  EXECUTED: "已执行",
};

export const APPROVAL_ACTION_LABEL: Record<string, string> = {
  TENANT_PURGE: "注销租户",
  TENANT_FORCE_PLAN: "强制改套餐/合同价",
  PRICE_CHANGE: "价格表生效",
  TAX_CHANGE: "调整开票税率",
  INVOICE_VOID: "发票红冲",
  BREAK_GLASS: "Break-glass 只读授权",
};

export const ROLE_LABEL: Record<string, string> = {
  platform_owner: "平台 Owner",
  platform_finance: "平台财务",
  platform_support: "平台客服",
  platform_ops: "平台运维",
  platform_readonly: "只读",
};

export function statusClass(status: string): string {
  switch (status) {
    case "ACTIVE":
    case "PAID":
    case "EXECUTED":
    case "APPROVED":
    case "OPEN":
      return "badge badge-ok";
    case "TRIAL":
    case "DRAFT":
    case "PENDING":
      return "badge badge-warn";
    case "OVERDUE":
    case "ISSUED":
      return "badge badge-warn";
    case "SUSPENDED":
    case "RED_FLUSH":
    case "REJECTED":
    case "EXPIRED":
    case "CANCELLED":
      return "badge badge-danger";
    default:
      return "badge";
  }
}
