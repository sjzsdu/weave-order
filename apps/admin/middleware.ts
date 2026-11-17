import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PREFIXES = ["/login", "/auth", "/api", "/_next", "/favicon"];
// 登录页也要显示的品牌图标 / PWA 图标：未登录时不能被会话守卫重定向到 /login，
// 否则 <img> 拿到的是 HTML，图标显示不出来。
const PUBLIC_ASSETS = ["/brand/", "/icon.svg", "/apple-icon.png"];
const SESSION_COOKIE = "weave_platform_token";

/**
 * 平台端会话守卫：只判「有没有 cookie」，不判「令牌是否过期」，更不删 cookie。
 *
 * 为什么移除本地 exp 判定：
 * - 令牌验签的唯一真相源是平台控制面（platform-api 的 jwtVerify：签名/JWKS/
 *   issuer/audience/有效期）。middleware 本地 atob 解 payload.exp 只是猜测，
 *   与真实验签存在时钟偏差、opaque 令牌、JWKS 轮转等不一致，会误杀正常会话。
 * - 过去这里命中「过期」就删 cookie，把一次本可恢复的「令牌验不过」升级成
 *   不可逆的「被登出」——用户表现为「点某个菜单突然被踢出去」。
 *
 * 现在分工：
 * - middleware：只拦「未登录」（没有 cookie），这是会话起点，不是登出；
 * - (console)/layout.tsx：调 /auth/me 做真实验签，401 → 登录页，403 → 无权限页；
 * - cookie 寿命由令牌真实 exp 决定（见 auth/callback/route.ts），到期浏览器自动清，
 *   因此不存在「cookie 还在、令牌已死」需要 middleware 抢着删的窗口。
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    PUBLIC_ASSETS.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  // 没有会话 cookie 就是未登录：回登录页。有 cookie 一律放行，
  // 有效性由 layout 的 /auth/me（控制面验签）判定——middleware 永不主动登出用户。
  if (!request.cookies.get(SESSION_COOKIE)?.value) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
