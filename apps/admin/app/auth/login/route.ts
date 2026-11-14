import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { publicOrigin } from "@/src/public-origin";

export const runtime = "nodejs";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 独立 Casdoor 应用 weave-platform：强制 MFA、禁止社交登录（应用侧配置）。
 * 这里只做 Authorization Code + PKCE，client secret 不进浏览器。
 */
export function GET(request: NextRequest) {
  const issuer = (process.env.CASDOOR_ISSUER ?? "https://sso.wnbgj.com").replace(/\/$/, "");
  const clientId = process.env.CASDOOR_PLATFORM_CLIENT_ID ?? "weave-platform";
  const origin = publicOrigin(request.nextUrl.origin);
  const redirectUri = `${origin}/auth/callback`;
  const next = request.nextUrl.searchParams.get("next") ?? "/";

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const authorize = new URL(`${issuer}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  // 平台端每次重新认证，避免共享终端残留会话。
  authorize.searchParams.set("prompt", "login");

  const secure = process.env.NODE_ENV === "production";
  const response = NextResponse.redirect(authorize);
  response.cookies.set("weave_platform_oidc_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 600,
  });
  response.cookies.set("weave_platform_oidc_verifier", verifier, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 600,
  });
  response.cookies.set("weave_platform_oidc_next", next, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 600,
  });
  return response;
}
