import type { Currency, Money } from "@weave-order/schema";

/**
 * 金额与数量的确定性运算。
 *
 * 铁律：金额一律以整数「分」参与运算；数量在库内以「千分之一单位」整数存储。
 * 因此内核计算全程是整数运算 + 一次显式四舍五入，不存在 IEEE754 累积误差。
 */

/** 数量 -> 千分之一单位整数。 */
export function quantityToMilli(value: number): number {
  return Math.round(value * 1000);
}

/** 千分之一单位整数 -> 数量。 */
export function milliToQuantity(milli: number): number {
  return milli / 1000;
}

/**
 * 单价（分/单位） × 数量 = 行金额（分）。
 * 先把数量放大为千分之一的整数，再对结果做一次 half-up 舍入。
 */
export function multiplyCents(unitPriceCents: number, quantityMilli: number): number {
  const product = unitPriceCents * quantityMilli;
  return Math.floor((product + 500) / 1000);
}

export function makeMoney(amount: number, currency: Currency): Money {
  return { amount, currency };
}

/** "123456" (CNY) -> "1,234.56"。仅用于终端演示输出。 */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  const grouped = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${fen.toString().padStart(2, "0")}`;
}

export function formatMoney(money: Money): string {
  return `${money.currency} ${formatCents(money.amount)}`;
}
