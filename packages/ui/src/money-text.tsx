import type { Money } from "@weave-order/schema";
import { cn } from "./primitives";
import { formatMoney } from "./money";

/**
 * 金额展示：等宽数字 + 右对齐 + 千分位。
 * 只做格式化，绝不在这里做金额计算。
 */
export function MoneyText({
  money,
  size = "md",
  muted = false,
  className,
}: {
  money: Money | null | undefined;
  size?: "sm" | "md" | "lg";
  muted?: boolean;
  className?: string;
}) {
  const sizeClass =
    size === "lg" ? "text-2xl font-bold" : size === "sm" ? "text-xs" : "text-sm font-semibold";
  return (
    <span
      className={cn(
        "font-mono tabular-nums text-right whitespace-nowrap",
        sizeClass,
        muted ? "text-ink-400" : "text-ink-900",
        className,
      )}
    >
      {formatMoney(money)}
    </span>
  );
}
