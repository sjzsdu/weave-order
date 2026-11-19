import type { CustomerListItem, Money } from "@weave-order/schema";
import { formatMoneyShort, relativeTime } from "./format";

/**
 * 客户列表一行 / 客户 360 头部的文案。
 *
 * 只做格式化，不排序、不聚合：数字与顺序都来自服务端读模型，
 * 这样列表和 PC 端才不会是「各算各的」。
 */

const TIER_LABEL: Record<string, string> = {
  VIP: "VIP",
  REGULAR: "常规",
  NEW: "新客",
  COLD: "沉睡",
};

export function tierLabel(tier: string): string {
  return TIER_LABEL[tier] ?? tier;
}

export function pendingAmountText(amounts: Money[]): string {
  if (amounts.length === 0) return "无未决";
  return amounts.map((money) => formatMoneyShort(money.amount, money.currency)).join(" / ");
}

/**
 * 行尾「有信息量」的入口文案：
 * 未决金额 > 逾期应收 > 最近往来 > 空态，点击仍然进客户 360。
 */
export function followupSummary(customer: CustomerListItem): string {
  const since = customer.lastContactAt ? relativeTime(customer.lastContactAt) : null;
  const money = pendingAmountText(customer.pendingQuoteAmount);
  if (customer.pendingQuoteCount > 0) {
    return `未决 ${money} · ${customer.pendingQuoteCount} 张${since ? ` · 最近 ${since}` : ""}`;
  }
  if (customer.overdueReceivableCount > 0) {
    return `逾期应收 ${customer.overdueReceivableCount} 笔${since ? ` · 最近 ${since}` : ""}`;
  }
  return since ? `最近往来 ${since}` : "还没有往来";
}

/** 有未决报价或逾期应收 = 今天该先看的人。 */
export function needsFollowup(customer: CustomerListItem): boolean {
  return customer.pendingQuoteCount > 0 || customer.overdueReceivableCount > 0;
}
