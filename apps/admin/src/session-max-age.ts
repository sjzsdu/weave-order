/**
 * 会话 cookie 寿命的计算规则。
 *
 * 单独成文件而不是放在 `app/auth/callback/route.ts` 里：Next.js 会校验
 * App Router 路由模块的导出字段，除 HTTP 方法与路由段配置外的具名导出
 * 一律会让 `next build` 失败（"xxx" is not a valid Route export field）。
 * 路由文件只留 GET，共享逻辑放这里。
 */

import { jwtPayload } from "@/src/session-cookie";

const DEFAULT_SESSION_SECONDS = 8 * 60 * 60;
const MAX_SESSION_SECONDS = 24 * 60 * 60;

/**
 * 会话 cookie 寿命 = 令牌剩余有效期（多留 30s 抵消验签时钟偏差），
 * 上限 24h、下限 60s。读不懂 exp（opaque 令牌等）时退回 8h 默认值，
 * 由控制面验签兜底——这里只决定浏览器何时自动丢弃 cookie，不做鉴权。
 */
export function sessionMaxAge(token: string, now: number = Date.now()): number {
  const payload = jwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return DEFAULT_SESSION_SECONDS;
  const remaining = Math.floor(exp - now / 1000) + 30;
  if (remaining <= 0) return 60;
  return Math.min(remaining, MAX_SESSION_SECONDS);
}
