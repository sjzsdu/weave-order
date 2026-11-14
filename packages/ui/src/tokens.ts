/**
 * 设计 tokens（product-design §9.1 / §9.2）。
 *
 * 视觉铁律：草稿态 = 浅底 + 虚线边 + 版本号；批准后 = 实底。
 * 桌面端与平台管理端共用；移动端（Taro）只引用数值，不复用 DOM 组件。
 *
 * 同时通过 tailwind-preset.cjs 暴露给 Tailwind 3（apps/web、apps/admin），
 * 组件类名与这里的命名一致。
 *
 * 官网（apps/site）用 Tailwind 4，构建期由 apps/site/scripts/sync-tokens.mjs
 * 把这里的 tokens 生成为 @theme —— 官网与应用共用同一套品牌色与字体，
 * 改色只改这一处。官网自己的布局常量（容器宽度、圆角、投影）留在官网侧，
 * 那是营销页的排版选择，与产品界面的组件规格不必一致。
 */
export const tokens = {
  color: {
    ink900: "#14202B",
    ink700: "#2B3B4A",
    ink500: "#4E5F6E",
    ink400: "#7A8896",
    paper: "#F7F4EE",
    paperDeep: "#EFE9DF",
    surface: "#FFFFFF",
    indigo600: "#1F4E79",
    indigo700: "#173E60",
    indigo100: "#E6EEF5",
    vermilion600: "#C0492F",
    vermilion100: "#FBEDEA",
    moss600: "#3F6B4F",
    moss100: "#EAF1EC",
    amber600: "#B7791F",
    amber100: "#FBF3E4",
    line: "#E3DED4",
    lineStrong: "#D3CCC0",
  },
  radius: { sm: 6, md: 10, lg: 14, pill: 999 },
  space: { xs: 4, sm: 8, md: 12, lg: 20, xl: 32 },
  font: {
    sans: '"Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    serif:
      '"Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", Georgia, serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
  fontSize: { xs: 12, sm: 13, md: 14, lg: 20, xl: 24, xxl: 32 },
  shadow: {
    card: "0 1px 2px rgba(20, 32, 43, 0.06), 0 1px 3px rgba(20, 32, 43, 0.04)",
  },
} as const;

export type DraftState = "draft" | "confirmed" | "rejected" | "failed";

/** 草稿/生效态的统一视觉参数，任何窗口都不得自行发明。 */
export const draftVisual = {
  draft: {
    background: tokens.color.surface,
    border: `1px dashed ${tokens.color.line}`,
    opacity: 1,
  },
  confirmed: {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.line}`,
    opacity: 1,
  },
  rejected: {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.vermilion600}33`,
    opacity: 0.92,
  },
  failed: {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.vermilion600}66`,
    opacity: 1,
  },
} as const;

/** 草稿态的 Tailwind 类名。所有卡片必须走它，保证跨窗口一致。 */
export const draftClassName: Record<DraftState, string> = {
  draft: "border-dashed border-line bg-surface",
  confirmed: "border border-line bg-surface",
  rejected: "border border-vermilion-600/30 bg-surface opacity-90",
  failed: "border border-vermilion-600/50 bg-surface",
};
