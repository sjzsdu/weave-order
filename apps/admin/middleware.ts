import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PREFIXES = ["/login", "/auth", "/api", "/_next", "/favicon"];

/**
 * 平台端生产：未登录一律回登录页（不暴露任何控制台数据）。
 * 本地 dev 放行，BFF 回退 dev:owner 便于无 Casdoor 联调。
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  if (process.env.NODE_ENV !== "production") return NextResponse.next();
  if (request.cookies.get("weave_platform_token")?.value) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
