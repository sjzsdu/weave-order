import type { ReactNode } from "react";
import type { Money } from "@weave-order/schema";
import { Card, cn } from "./primitives";
import type { DraftState } from "./tokens";
import { MoneyText } from "./money-text";

/**
 * 所有 AI 产出卡片的统一外壳。
 * 草稿态必须是「浅底 + 虚线边 + 版本号」，批准后才变实底。
 */
export function DraftCard({
  title,
  subtitle,
  state = "draft",
  version,
  amount,
  badge,
  meta,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  state?: DraftState;
  version?: number;
  amount?: Money | null;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card state={state} className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-xl font-semibold leading-tight text-ink-900">{title}</h3>
            {badge}
            <span className="rounded-full bg-paper px-2 py-0.5 text-xs text-ink-400">
              v{version ?? 1}
              {state === "draft" ? " · 草稿" : state === "rejected" ? " · 已驳回" : ""}
            </span>
          </div>
          {subtitle && <div className="mt-1 text-sm text-ink-400">{subtitle}</div>}
          {meta && <div className="mt-2 text-[13px] text-ink-700">{meta}</div>}
        </div>
        {amount !== undefined && <MoneyText money={amount} size="lg" />}
      </div>
      {children}
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </Card>
  );
}
