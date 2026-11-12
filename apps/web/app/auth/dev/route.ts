import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

/** 本地 dev 网关接受 `dev:<sub>:<org>`；生产环境一律 404。 */
export function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }
  const token = process.env.DEV_AUTH_TOKEN ?? "dev:demo:demo";
  const next = request.nextUrl.searchParams.get("next") ?? "/today";
  const response = NextResponse.redirect(new URL(next, request.url));
  response.cookies.set("weave_token", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}
