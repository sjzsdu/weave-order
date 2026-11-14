/**
 * 官网埋点的小门面。
 *
 * 真正的逻辑在 `public/assets/analytics.js`（事件字典、属性白名单、provider 注入）。
 * 这里只做两件事：类型声明，以及「脚本没加载 / 没配置时静默变成空操作」。
 * 页面脚本不直接碰 window.weaveAnalytics，避免每处都写一遍判空。
 */

type TrackFn = (event: string, props?: Record<string, string>) => boolean;

declare global {
  interface Window {
    weaveAnalytics?: { track?: TrackFn; enabled?: boolean };
  }
}

export function trackEvent(event: string, props?: Record<string, string>): void {
  if (typeof window === "undefined") return;
  const analytics = window.weaveAnalytics;
  if (analytics && typeof analytics.track === "function") analytics.track(event, props);
}

/** 表单已经交给邮件客户端（不读表单内容）。 */
export function trackFormSubmit(): void {
  trackEvent("signup_form_submit");
}
