import type { Currency } from "@weave-order/schema";

const CURRENCY_SYMBOL: Record<Currency, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  HKD: "HK$",
};

/** 金额只以整数分进入前端；展示时才转元，且固定两位小数。 */
export function formatMoney(amountCents: number, currency: Currency = "CNY"): string {
  const symbol = CURRENCY_SYMBOL[currency];
  const negative = amountCents < 0;
  const abs = Math.abs(Math.trunc(amountCents));
  const yuan = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${symbol}${grouped}.${cents.toString().padStart(2, "0")}`;
}

/** 大额卡片只显示整数元，避免小数噪音。 */
export function formatMoneyShort(amountCents: number, currency: Currency = "CNY"): string {
  return formatMoney(amountCents, currency).replace(/\.00$/, "");
}

/** 单价：元 + 两位小数（15.20 元/米）。 */
export function formatUnitPrice(amountCents: number, currency: Currency = "CNY"): string {
  return `${formatMoney(amountCents, currency)}`;
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return "";
  const diffMs = now.getTime() - target;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export function shortDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 客户手机号默认脱敏。 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "未留电话";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "已脱敏";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

const TECHNICAL_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * 负责人展示文案：像 UUID 的值绝不显示（WAN-151）。
 * 后端已只回姓名/邮箱副本，这里挡住历史数据与其它域的回退。
 */
export function ownerLabel(ownerName: string | null | undefined, ownerId?: string | null): string {
  const name = ownerName?.trim();
  if (name && !TECHNICAL_ID_PATTERN.test(name)) return name;
  return ownerId ? "同事" : "未分配";
}
