import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { safeNext } from "@/public-origin";
import { isProductionLike } from "@/runtime-mode";

export const runtime = "nodejs";

/** 本地 dev 网关接受 `dev:<sub>:<org>`；生产态（含 staging）一律 404。 */
export function GET(request: NextRequest) {
  if (isProductionLike()) {
    return new NextResponse("Not found", { status: 404 });
  }
  const token = process.env.DEV_AUTH_TOKEN ?? "dev:demo:demo";
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const response = NextResponse.redirect(new URL(next, request.url));
  response.cookies.set("weave_token", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}
