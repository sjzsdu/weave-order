import type { Currency, Money } from "@weave-order/schema";

const formatterCache = new Map<Currency, Intl.NumberFormat>();

function formatter(currency: Currency): Intl.NumberFormat {
  const cached = formatterCache.get(currency);
  if (cached) return cached;
  const next = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  });
  formatterCache.set(currency, next);
  return next;
}

/**
 * 金额展示：分 → 带币种字符串。金额计算永远在服务端，这里只格式化。
 * 负值保留符号（退款/折让），不使用浮点乘法。
 */
export function formatCents(amount: number, currency: Currency): string {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  const yuan = Math.trunc(absolute / 100);
  const cents = (absolute % 100).toString().padStart(2, "0");
  const formatted = formatter(currency).format(yuan).replace(/\.00$/, "");
  return `${sign}${formatted}.${cents}`;
}

export function formatMoney(money: Money | null | undefined): string {
  return money ? formatCents(money.amount, money.currency) : "—";
}
