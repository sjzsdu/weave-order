import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { platformSessionState } from "@/src/session-cookie";

const PUBLIC_PREFIXES = ["/login", "/auth", "/api", "/_next", "/favicon"];
const SESSION_COOKIE = "weave_platform_token";

/**
 * 平台端生产：没有可用会话一律回登录页（不暴露任何控制台数据）。
 * 本地 dev 放行，BFF 回退 dev:owner 便于无 Casdoor 联调。
 *
 * 这里只判断「cookie 是否可能有效」，不做验签与权限判定（那是控制面的职责）。
 * 目的是别让过期会话进入控制台 SSR：否则 layout 的 redirect 与子页面
 * platformFetch 的异常会同时冒泡，Next.js 生产环境直接返回 __next_error__ 页面，
 * 浏览器只显示 "Application error ... Digest: xxx"。
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  const state = platformSessionState(request.cookies.get(SESSION_COOKIE)?.value, {
    production: true,
  });
  if (state === "usable") return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  if (state !== "missing") {
    login.searchParams.set("error", "会话已失效，请重新登录");
  }

  const response = NextResponse.redirect(login);
  // 过期 / dev 令牌就地清掉，避免每次访问都重复触发同一次失败渲染。
  if (state !== "missing") response.cookies.delete(SESSION_COOKIE);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
