import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PREFIXES = ["/login", "/auth", "/api", "/_next", "/favicon"];

/**
 * 生产：未登录一律回登录页；本地 dev（NODE_ENV != production）放行，
 * 便于没有 Casdoor 时用 dev token 联调。
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  const token = request.cookies.get("weave_token")?.value;
  const demo = request.cookies.get("weave_demo")?.value;
  if (token || demo) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
