import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isProductionLike } from "@/runtime-mode";

// /config.js 是部署期配置（目前只有访问统计），登录页也要读它，必须免登录。
const PUBLIC_PREFIXES = ["/login", "/auth", "/api", "/_next", "/favicon", "/config.js"];

/**
 * 生产态（isProductionLike()，与 api 同一份判定）：未登录一律回登录页；本地 dev 放行，
 * 便于没有 Casdoor 时用 dev token 联调。
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  if (!isProductionLike()) return NextResponse.next();

  const token = request.cookies.get("weave_token")?.value;
  if (token) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
