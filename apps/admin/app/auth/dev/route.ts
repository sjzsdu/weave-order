import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { safeNext } from "@/src/safe-next";

export const runtime = "nodejs";

/** 本地 dev 身份切换：生产环境一律 404。 */
export function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }
  const subject = request.nextUrl.searchParams.get("subject") ?? "owner";
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const response = NextResponse.redirect(new URL(next, request.url));
  response.cookies.set("weave_platform_token", `dev:${subject.replace(/^dev:/, "")}`, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}
