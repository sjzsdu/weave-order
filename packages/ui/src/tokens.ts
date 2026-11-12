/**
 * 设计 tokens：桌面端与平台管理端共用；移动端（Taro）只能引用数值，
 * 不直接复用 DOM 组件。
 *
 * 视觉铁律：草稿态 = 浅底 + 虚线边 + 版本号；批准后 = 实底。
 */
export const tokens = {
  color: {
    bg: "#f7f7f5",
    surface: "#ffffff",
    ink: "#16181d",
    inkMuted: "#5f646d",
    line: "#e3e3df",
    accent: "#1f6f5c",
    accentSoft: "#e8f2ee",
    warn: "#b26a00",
    warnSoft: "#fdf3e2",
    danger: "#b3261e",
    dangerSoft: "#fbeceb",
    info: "#1d4ed8",
    infoSoft: "#eaeffd",
  },
  radius: { sm: 6, md: 10, lg: 16, pill: 999 },
  space: { xs: 4, sm: 8, md: 12, lg: 20, xl: 32 },
  font: {
    sans: '"Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
  fontSize: { xs: 12, sm: 13, md: 14, lg: 18, xl: 24 },
  shadow: {
    card: "0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.04)",
  },
} as const;

export type DraftState = "draft" | "confirmed";

/** 草稿/生效态的统一视觉参数，任何窗口都不得自行发明。 */
export const draftVisual = {
  draft: {
    background: tokens.color.surface,
    border: `1px dashed ${tokens.color.line}`,
    opacity: 0.92,
  },
  confirmed: {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.line}`,
    opacity: 1,
  },
} as const;
