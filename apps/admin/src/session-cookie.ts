/**
 * 平台会话 cookie 的轻量本地判定（只给 middleware 用，不做签名校验）。
 *
 * 真正的验签、MFA、平台人员名册与权限都在 weave-platform-api。
 * 这里只拦「明确已过期」和「生产环境的 dev 令牌」，把无效会话挡在控制台
 * SSR 之前：否则 layout 的 redirect 与 page 的 platformFetch 异常会同时冒泡，
 * Next.js 生产环境就返回 `__next_error__` 页面，浏览器显示
 * "Application error: a server-side exception has occurred ... Digest: xxx"。
 *
 * 看不懂的令牌一律放行，交给控制面判定，避免把正常会话误踢。
 */

export type PlatformSessionState = "missing" | "expired" | "dev" | "usable";

/** 允许 30 秒时钟偏差，避免边界上反复踢登录。 */
const CLOCK_SKEW_SECONDS = 30;

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function platformSessionState(
  token: string | null | undefined,
  options: { now?: number; production?: boolean } = {},
): PlatformSessionState {
  if (!token) return "missing";
  if (token.startsWith("dev:")) return options.production ? "dev" : "usable";

  const payload = jwtPayload(token);
  if (!payload) return "usable";

  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return "usable";
  const nowSeconds = (options.now ?? Date.now()) / 1000;
  return exp + CLOCK_SKEW_SECONDS <= nowSeconds ? "expired" : "usable";
}
