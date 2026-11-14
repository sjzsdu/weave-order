import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { publicOrigin } from "@/public-origin";

export const runtime = "nodejs";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Casdoor OIDC Authorization Code + PKCE。
 * 前端不持有 client secret；回调由 /auth/callback 在服务端换 token。
 */
export function GET(request: NextRequest) {
  const issuer = process.env.CASDOOR_ISSUER ?? "https://sso.wnbgj.com";
  const clientId = process.env.CASDOOR_CLIENT_ID ?? "weave-order-web";
  const origin = publicOrigin(request.nextUrl.origin);
  const redirectUri = `${origin}/auth/callback`;
  const next = request.nextUrl.searchParams.get("next") ?? "/today";

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const authorize = new URL(`${issuer.replace(/\/$/, "")}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authorize);
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set("weave_oidc_state", state, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 600 });
  response.cookies.set("weave_oidc_verifier", verifier, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 600 });
  response.cookies.set("weave_oidc_next", next, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 600 });
  return response;
}
