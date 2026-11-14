import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // 先吊销服务端会话（幂等）：只删浏览器 Cookie 的话，一把被复制的 sid 还能用到 TTL。
  const sid = request.cookies.get("weave_sid")?.value;
  if (sid) {
    const target = (process.env.API_PROXY_TARGET ?? "http://localhost:3000").replace(/\/$/, "");
    await fetch(`${target}/api/auth/session`, {
      method: "DELETE",
      headers: { cookie: `weave_sid=${sid}` },
      cache: "no-store",
    }).catch(() => undefined);
  }
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.delete("weave_token");
  response.cookies.delete("weave_demo");
  response.cookies.delete("weave_sid");
  return response;
}
