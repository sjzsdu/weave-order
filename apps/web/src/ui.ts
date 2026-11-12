/** 共享的 Tailwind 类串。字面量写在这里，Tailwind content 扫描会收录这些候选类。 */
export const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_PRIMARY = `${BTN_BASE} border border-[#2f5a3d] bg-accent-dark text-accent hover:bg-[#26563a]`;
export const BTN_DANGER = `${BTN_BASE} border border-[#5c2e31] bg-[#3a1f22] text-danger hover:bg-[#4a272a]`;
export const BTN_GHOST = `${BTN_BASE} border border-line bg-[#11161c] text-text hover:border-[#3a4756]`;
export const BTN_INTENT =
  "flex w-full flex-col items-start gap-1 rounded-xl border border-line bg-[#11161c] px-4 py-3 text-left transition-colors hover:border-accent/60 hover:bg-[#151d26] disabled:cursor-not-allowed disabled:opacity-50";
export const SELECT =
  "w-full rounded-lg border border-line bg-[#11161c] px-3 py-2 text-sm text-text outline-none focus:border-accent";
export const INPUT =
  "w-full rounded-lg border border-line bg-[#11161c] px-3 py-2 text-sm text-text outline-none placeholder:text-muted/70 focus:border-accent";
export const BADGE_BASE = "rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide";
export const CARD = "wo-card";
