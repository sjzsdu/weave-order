import type { Currency, Timestamp } from "@weave-order/schema";

export function toIso(date: Date): Timestamp {
  return date.toISOString();
}

export function toIsoOrNull(date: Date | null): Timestamp | null {
  return date ? toIso(date) : null;
}

export function currencyOf(value: string): Currency {
  // 数据库枚举与契约枚举同步（边界测试会校验），这里仅做类型收窄。
  return value as Currency;
}
