import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isProductionLike } from "@/runtime-mode";
import { appVersionLabel } from "@/format";

// /config.js 是部署期配置（目前只有访问统计），登录页也要读它，必须免登录。
const PUBLIC_PREFIXES = ["/login", "/auth", "/api", "/_next", "/favicon", "/config.js"];

/**
 * 给每个响应带上构建期注入的版本号，供发布验收在不需要登录的情况下核对。
 * 页脚只有登录后才看得到（登录页没有桌面壳的页脚），而 `/today` 未登录是 307，
 * 所以「页脚版本对不对」只能靠这个响应头在发布后立刻验。
 * 没有注入版本（本地 / sha 构建）时不带这个头，绝不编一个版本出来。
 */
function withAppVersion(response: NextResponse): NextResponse {
  const version = appVersionLabel(process.env.NEXT_PUBLIC_APP_VERSION);
  if (version) response.headers.set("x-weave-version", version);
  return response;
}

/**
 * 生产态（isProductionLike()，与 api 同一份判定）：未登录一律回登录页；本地 dev 放行，
 * 便于没有 Casdoor 时用 dev token 联调。
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return withAppVersion(NextResponse.next());
  }
  if (!isProductionLike()) return withAppVersion(NextResponse.next());

  const token = request.cookies.get("weave_token")?.value;
  if (token) return withAppVersion(NextResponse.next());

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  return withAppVersion(NextResponse.redirect(login));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
