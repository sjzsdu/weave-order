import type { CSSProperties, ReactNode } from "react";
import { draftVisual, tokens } from "./tokens";
import type { DraftState } from "./tokens";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const buttonBase: CSSProperties = {
  fontFamily: tokens.font.sans,
  fontSize: tokens.fontSize.md,
  borderRadius: tokens.radius.md,
  padding: `${tokens.space.sm}px ${tokens.space.lg}px`,
  border: `1px solid ${tokens.color.line}`,
  cursor: "pointer",
  background: tokens.color.surface,
  color: tokens.color.ink,
};

export function Button({
  children,
  variant = "secondary",
  disabled,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  const variantStyle: CSSProperties =
    variant === "primary"
      ? { background: tokens.color.accent, borderColor: tokens.color.accent, color: "#fff" }
      : variant === "danger"
        ? {
            background: tokens.color.dangerSoft,
            borderColor: tokens.color.danger,
            color: tokens.color.danger,
          }
        : {};
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{ ...buttonBase, ...variantStyle, opacity: disabled ? 0.5 : 1 }}
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
}: {
  children: ReactNode;
  state?: DraftState;
  version?: number;
  title?: ReactNode;
}) {
  return (
    <section
      style={{
        ...draftVisual[state],
        borderRadius: tokens.radius.lg,
        boxShadow: tokens.shadow.card,
        padding: tokens.space.lg,
        fontFamily: tokens.font.sans,
        color: tokens.color.ink,
      }}
    >
      {(title || version) && (
        <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          {version !== undefined && (
            <span style={{ color: tokens.color.inkMuted, fontSize: tokens.fontSize.xs }}>
              v{version}
              {state === "draft" ? " · 草稿" : ""}
            </span>
          )}
        </header>
      )}
      {children}
    </section>
  );
}

const badgePalette = {
  neutral: { background: tokens.color.bg, color: tokens.color.inkMuted },
  success: { background: tokens.color.accentSoft, color: tokens.color.accent },
  warning: { background: tokens.color.warnSoft, color: tokens.color.warn },
  danger: { background: tokens.color.dangerSoft, color: tokens.color.danger },
  info: { background: tokens.color.infoSoft, color: tokens.color.info },
} as const;

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof badgePalette;
}) {
  return (
    <span
      style={{
        ...badgePalette[tone],
        borderRadius: tokens.radius.pill,
        padding: "2px 10px",
        fontSize: tokens.fontSize.xs,
        fontFamily: tokens.font.sans,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function MoneyText({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
      }}
    >
      {children}
    </span>
  );
}
