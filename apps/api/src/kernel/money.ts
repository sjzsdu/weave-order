import type { Currency, Money } from "@weave-order/schema";
import { KernelError } from "./errors";

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
 *
 * 用 BigInt 做乘法再用一次 half-up 舍入：金额列已经是 bigint，
 * 中间结果可以超过 2^53，不能交给 IEEE754。结果超出安全整数时显式拒绝，
 * 而不是静默丢精度。
 */
export function multiplyCents(unitPriceCents: number, quantityMilli: number): number {
  if (
    !Number.isSafeInteger(unitPriceCents) ||
    !Number.isSafeInteger(quantityMilli) ||
    unitPriceCents < 0 ||
    quantityMilli < 0
  ) {
    throw new KernelError("KERNEL_REJECTED", "金额/数量必须是非负安全整数", {
      reason: "UNSAFE_ARITHMETIC_INPUT",
    });
  }
  const rounded = (BigInt(unitPriceCents) * BigInt(quantityMilli) + 500n) / 1000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new KernelError("KERNEL_REJECTED", `行金额超出安全整数范围：${rounded.toString()} 分`, {
      reason: "AMOUNT_OVERFLOW",
    });
  }
  return Number(rounded);
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
