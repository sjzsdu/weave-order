import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

interface CasdoorTokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
  data?: { access_token?: string; id_token?: string };
}

/** OIDC 回调：校 state → 用 code + PKCE verifier 换 token → 写会话 Cookie。 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  const next = request.cookies.get("weave_oidc_next")?.value ?? "/today";

  const fail = (message: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, request.url));

  if (error) return fail(params.get("error_description") ?? error);
  if (!code) return fail("缺少授权码");
  if (!state || state !== request.cookies.get("weave_oidc_state")?.value) return fail("state 校验失败");

  const issuer = (process.env.CASDOOR_ISSUER ?? "https://sso.wnbgj.com").replace(/\/$/, "");
  const clientId = process.env.CASDOOR_CLIENT_ID ?? "weave-order-web";
  const clientSecret = process.env.CASDOOR_CLIENT_SECRET;
  const redirectUri = `${process.env.PUBLIC_APP_URL ?? request.nextUrl.origin}/auth/callback`;
  const verifier = request.cookies.get("weave_oidc_verifier")?.value;

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });
  if (clientSecret) form.set("client_secret", clientSecret);
  if (verifier) form.set("code_verifier", verifier);

  let body: CasdoorTokenResponse;
  try {
    const tokenResponse = await fetch(`${issuer}/api/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
      cache: "no-store",
    });
    body = (await tokenResponse.json()) as CasdoorTokenResponse;
    if (!tokenResponse.ok) return fail(body.error_description ?? body.error ?? "换取令牌失败");
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : "身份服务不可达");
  }

  const token = body.id_token ?? body.data?.id_token ?? body.access_token ?? body.data?.access_token;
  if (!token) return fail("身份服务未返回令牌");

  const response = NextResponse.redirect(new URL(next, request.url));
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set("weave_token", token, {
    httpOnly: false, // 浏览器端 API client 需要携带；生产应换成 BFF 会话代理
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  response.cookies.delete("weave_oidc_state");
  response.cookies.delete("weave_oidc_verifier");
  response.cookies.delete("weave_oidc_next");
  return response;
}
