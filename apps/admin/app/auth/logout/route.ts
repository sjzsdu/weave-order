import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { publicOrigin } from "@/src/public-origin";

export function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", publicOrigin(request.nextUrl.origin)));
  response.cookies.delete("weave_platform_token");
  return response;
}
