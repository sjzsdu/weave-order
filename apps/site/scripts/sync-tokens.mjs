/**
 * 把 packages/ui 的设计 tokens 生成成 Tailwind v4 的 @theme 块。
 *
 * 为什么要有这一步：官网（apps/site）与产品应用（apps/web、apps/admin）
 * 必须是同一套品牌色与字体。以前官网自己抄了一份 CSS 变量，改色要改两处；
 * 现在官网的 @theme 由 tokens.ts 生成，改色只改 packages/ui 一处。
 *
 * 官网自己的排版常量（容器宽度、圆角、投影）不在 tokens.ts 里，
 * 那些是营销页的排版选择，留在 src/styles/global.css 的 :root 里。
 *
 * 运行：node scripts/sync-tokens.mjs（astro build 前会自动跑）
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokens } from "@weave-order/ui/tokens";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "src", "styles", "theme.css");

/** tokens.ts 的字段 → Tailwind v4 的主题命名空间。 */
const COLOR_MAP = {
  ink900: "ink-900",
  ink700: "ink-700",
  ink500: "ink-500",
  ink400: "ink-400",
  paper: "paper",
  paperDeep: "paper-deep",
  surface: "surface",
  indigo600: "indigo-600",
  indigo700: "indigo-700",
  indigo100: "indigo-100",
  vermilion600: "vermilion-600",
  vermilion100: "vermilion-100",
  moss600: "moss-600",
  moss100: "moss-100",
  amber600: "amber-600",
  amber100: "amber-100",
  line: "line",
  lineStrong: "line-strong",
};

/**
 * 十六进制色值统一小写。
 * tokens.ts 里写的是大写（#14202B），但生成物要跟 prettier 的输出一致，
 * 否则每次 build 都会把已格式化的文件改回去，format:check 永远红。
 */
function lowerHex(value) {
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value.toLowerCase() : value;
}

const entries = [];
for (const [key, name] of Object.entries(COLOR_MAP)) {
  const value = tokens.color[key];
  if (!value) throw new Error(`tokens.color 里没有 ${key}`);
  entries.push([`--color-${name}`, lowerHex(value)]);
}

for (const [key, name] of Object.entries({
  sans: "sans",
  serif: "serif",
  mono: "mono",
})) {
  entries.push([`--font-${name}`, tokens.font[key]]);
}

for (const [key, name] of Object.entries({
  xs: "xs",
  sm: "sm",
  md: "md",
  lg: "lg",
  xl: "xl",
  xxl: "2xl",
})) {
  entries.push([`--text-${name}`, `${tokens.fontSize[key]}px`]);
}

for (const [key, name] of Object.entries({ sm: "sm", md: "md", lg: "lg", pill: "pill" })) {
  entries.push([`--radius-${name}`, `${tokens.radius[key]}px`]);
}

for (const [key, name] of Object.entries({
  xs: "xs",
  sm: "sm",
  md: "md",
  lg: "lg",
  xl: "xl",
})) {
  entries.push([`--spacing-${name}`, `${tokens.space[key]}px`]);
}

entries.push(["--shadow-card", tokens.shadow.card]);

const body = entries.map(([name, value]) => `  ${name}: ${value};`).join("\n");

const css = [
  "/* 由 scripts/sync-tokens.mjs 生成，请勿手改。",
  " * 源头是 packages/ui/src/tokens.ts —— 改品牌色与字体请改那里。 */",
  "@theme {",
  body,
  "}",
  "",
].join("\n");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, css, "utf8");
console.log(`已生成 ${outPath}（${entries.length} 个主题变量）`);
