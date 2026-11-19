import { Text, View } from "@tarojs/components";
import type { PropsWithChildren, ReactNode } from "react";
import type { CSSProperties } from "react";
import { useEffect } from "react";
import { sheetTabBar } from "../lib/sheet-tabbar";
import { back } from "../routes";

/** 移动端基础组件：只对齐 tokens，不复用 DOM 组件（packages/ui 仅桌面）。 */

/**
 * 二级页导航栏：H5/PWA 没有浏览器返回按钮，必须由页面自己给出口。
 * 小程序 / RN 有原生导航栏（自带返回），这里不渲染，避免双层标题。
 */
export function NavBar({ title, subtitle }: { title: string; subtitle?: string }) {
  if (process.env.TARO_ENV !== "h5") return null;
  return (
    <View className="navbar">
      <View className="navbar-back" ariaRole="button" ariaLabel="返回" onClick={() => back()}>
        <View className="navbar-back-arrow" />
      </View>
      <View className="navbar-main">
        <View className="navbar-title">{title}</View>
        {subtitle && <View className="navbar-sub">{subtitle}</View>}
      </View>
      <View className="navbar-side" />
    </View>
  );
}

export function Page({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <View className={`page ${className}`}>{children}</View>;
}

export function Card({
  children,
  className = "",
  onClick,
  style,
}: PropsWithChildren<{ className?: string; onClick?: () => void; style?: CSSProperties }>) {
  return (
    <View className={`card ${className}`} onClick={onClick} style={style}>
      {children}
    </View>
  );
}

export function SectionTitle({
  title,
  hint,
  extra,
}: {
  title: string;
  hint?: string;
  extra?: ReactNode;
}) {
  return (
    <View className="section-head">
      <View>
        <View className="section-title">{title}</View>
        {hint && <View className="section-hint">{hint}</View>}
      </View>
      {extra}
    </View>
  );
}

export type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "info";

export function Badge({ children, tone = "neutral" }: PropsWithChildren<{ tone?: BadgeTone }>) {
  return <Text className={`badge badge-${tone}`}>{children}</Text>;
}

export type ButtonVariant = "primary" | "danger" | "ghost" | "soft";

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled = false,
  loading = false,
  block = false,
  small = false,
}: PropsWithChildren<{
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  block?: boolean;
  small?: boolean;
}>) {
  return (
    <View
      className={`btn btn-${variant}${block ? " btn-block" : ""}${small ? " btn-small" : ""}${
        disabled || loading ? " btn-disabled" : ""
      }`}
      onClick={() => {
        if (!disabled && !loading) onClick?.();
      }}
    >
      {loading ? "处理中…" : children}
    </View>
  );
}

export function EmptyState({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <View className="empty">
      <View className="empty-title">{title}</View>
      {desc && <View className="empty-desc">{desc}</View>}
      {action && <View className="empty-action">{action}</View>}
    </View>
  );
}

export function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "warn" | "danger" | "accent";
}) {
  return (
    <View className="stat">
      <View className={`stat-value stat-${tone}`}>{value}</View>
      <View className="stat-label">{label}</View>
    </View>
  );
}

export function Amount({
  children,
  size = "md",
}: PropsWithChildren<{ size?: "sm" | "md" | "lg" }>) {
  return <Text className={`amount amount-${size}`}>{children}</Text>;
}

export function Field({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <View className="field" onClick={onClick}>
      <View className="field-label">{label}</View>
      <View className="field-value">{value}</View>
      {hint && <View className="field-hint">{hint}</View>}
    </View>
  );
}

export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: PropsWithChildren<{
  open: boolean;
  title: string;
  onClose: () => void;
  footer?: ReactNode;
}>) {
  // 弹层在 `.taro_page` 内部，z-index 再高也盖不住页面外的 tabbar（见 lib/sheet.ts），
  // 打开期间收起 tabbar，关闭后恢复。非 tabbar 页面会静默跳过。
  useEffect(() => {
    if (!open) return;
    return sheetTabBar.acquire();
  }, [open]);

  if (!open) return null;
  return (
    <View className="sheet-layer">
      <View className="sheet-mask" onClick={onClose} />
      <View className="sheet">
        <View className="sheet-head">
          <View className="sheet-title">{title}</View>
          <Text className="sheet-close" onClick={onClose}>
            关闭
          </Text>
        </View>
        <View className="sheet-body">{children}</View>
        {footer && <View className="sheet-footer">{footer}</View>}
      </View>
    </View>
  );
}

export function OfflineBanner({ text, onClick }: { text: string; onClick?: () => void }) {
  return (
    <View className="offline-banner" onClick={onClick}>
      <Text className="offline-dot" />
      <Text>{text}</Text>
    </View>
  );
}

export function Loading({ label = "加载中…" }: { label?: string }) {
  return <View className="loading">{label}</View>;
}
