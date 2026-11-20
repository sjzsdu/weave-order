/**
 * 统一输入入口（WAN-196 空状态引导）。
 *
 * 统一输入页（WAN-194 的 `/inbound`）与本切片并行开发，上线时间不确定，
 * 所以入口按「路由是否已配置」降级：
 * - 配了 `NEXT_PUBLIC_UNIFIED_INPUT_ROUTE`（部署期环境变量）→ 直接去统一输入页；
 * - 没配 → 回到 `/today?intent=…`，那里现有的意图栏就是今天唯一的统一输入，
 *   `/today` 对带 `intent` 的深链不重定向（见 today/page.tsx）。
 *
 * 这样在 WAN-194 合并前空状态不会点出一个 404，合并后也不用改调用点。
 */
export function unifiedInputHref(prompt: string): string {
  const route = process.env.NEXT_PUBLIC_UNIFIED_INPUT_ROUTE;
  const base = route?.trim() || "/today";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}intent=${encodeURIComponent(prompt)}`;
}

export const UNIFIED_INPUT_PROMPT = "用一句话或一张照片开始：客户、样品、数量说清楚就行";
