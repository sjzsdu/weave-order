import type { ButtonHTMLAttributes, ReactNode } from "react";
import { draftClassName } from "./tokens";
import type { DraftState } from "./tokens";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const BUTTON_VARIANTS = {
  primary: "bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700",
  secondary: "bg-surface text-ink-900 border-line hover:bg-paper",
  ghost: "bg-transparent text-ink-700 border-transparent hover:bg-paper",
  danger: "bg-vermilion-600/10 text-vermilion-600 border-vermilion-600/40 hover:bg-vermilion-600/15",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  type?: "button" | "submit";
  children: ReactNode;
}

/** 触控目标 ≥ 44px；主操作只有一个（由页面保证）。 */
export function Button({
  children,
  variant = "secondary",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  state = "confirmed",
  version,
  title,
  className,
}: {
  children: ReactNode;
  state?: DraftState;
  version?: number;
  title?: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-state={state}
      className={cn("rounded-lg p-5 text-ink-900 shadow-card", draftClassName[state], className)}
    >
      {(title || version !== undefined) && (
        <header className="mb-3 flex items-start justify-between gap-4">
          <div className="text-base font-semibold">{title}</div>
          {version !== undefined && (
            <span className="text-xs text-ink-400">
              v{version}
              {state === "draft" ? " · 草稿" : state === "rejected" ? " · 已驳回" : ""}
            </span>
          )}
        </header>
      )}
      {children}
    </section>
  );
}

const BADGE_TONES = {
  neutral: "bg-paper text-ink-700",
  info: "bg-indigo-100 text-indigo-600",
  success: "bg-moss-600/10 text-moss-600",
  warning: "bg-amber-600/10 text-amber-600",
  danger: "bg-vermilion-600/10 text-vermilion-600",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ label = "加载中" }: { label?: string }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-ink-400">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-indigo-600" />
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-900">{title}</p>
      {description && <p className="mt-1 text-sm text-ink-400">{description}</p>}
      {actions && <div className="mt-4 flex justify-center gap-2">{actions}</div>}
    </div>
  );
}
