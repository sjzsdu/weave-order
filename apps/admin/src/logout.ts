import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { publicOrigin } from "./public-origin";

export const SESSION_COOKIE = "weave_platform_token";

/**
 * 登出必须是 POST，且只接受同源请求。
 *
 * - Next.js App Router 会预取视口内的 <Link>，GET 登出等于「页面加载一次就把人踢下线」。
 * - 即使改成 POST，跨站表单提交仍会带上目标站点的 cookie 并接受响应的 Set-Cookie，
 *   所以还要校验来源，避免第三方页面用自动提交的表单强制用户登出（CSRF 登出）。
 *
 * 判定顺序：Origin → Sec-Fetch-Site → Referer。三者都没有时按跨站处理（拒绝）。
 */
export function isSameOriginRequest(request: NextRequest): boolean {
  const expected = publicOrigin(request.nextUrl.origin);
  const origin = request.headers.get("origin");
  if (origin) return origin === expected;

  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";

  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

/** 清会话并 303 回登录页（303 让 POST 之后的浏览器改用 GET，不会重放表单）。 */
export function logoutResponse(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(
    new URL("/login", publicOrigin(request.nextUrl.origin)),
    303,
  );
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
