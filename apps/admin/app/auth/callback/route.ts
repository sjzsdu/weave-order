import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { sessionMaxAge } from "@/src/session-max-age";
import { publicOrigin } from "@/src/public-origin";
import { safeNext } from "@/src/safe-next";

export const runtime = "nodejs";

interface CasdoorTokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
  data?: { access_token?: string; id_token?: string };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  const next = safeNext(request.cookies.get("weave_platform_oidc_next")?.value);
  const origin = publicOrigin(request.nextUrl.origin);

  const fail = (message: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, origin));

  if (error) return fail(params.get("error_description") ?? error);
  if (!code) return fail("缺少授权码");
  if (!state || state !== request.cookies.get("weave_platform_oidc_state")?.value) {
    return fail("state 校验失败，请重新登录");
  }

  const issuer = (process.env.CASDOOR_ISSUER ?? "https://sso.wnbgj.com").replace(/\/$/, "");
  const clientId = process.env.CASDOOR_PLATFORM_CLIENT_ID ?? "weave-platform";
  const clientSecret = process.env.CASDOOR_PLATFORM_CLIENT_SECRET;
  const redirectUri = `${origin}/auth/callback`;
  const verifier = request.cookies.get("weave_platform_oidc_verifier")?.value;

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
    const response = await fetch(`${issuer}/api/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
      cache: "no-store",
    });
    body = (await response.json()) as CasdoorTokenResponse;
    if (!response.ok) return fail(body.error_description ?? body.error ?? "换取令牌失败");
  } catch (cause) {
    // 网络层报错是英文技术文案（fetch failed），登录页只展示可读的中文。
    console.error("[admin] 令牌交换请求失败", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return fail("身份服务暂时不可达，请稍后重试或联系平台管理员");
  }

  const token =
    body.id_token ?? body.data?.id_token ?? body.access_token ?? body.data?.access_token;
  if (!token) return fail("身份服务未返回令牌");

  const secure = process.env.NODE_ENV === "production";
  // Cookie 寿命对齐令牌真实 exp：过去写死 8h，而 Casdoor id_token 往往短得多，
  // 导致「cookie 还在、令牌已死」——middleware 只能靠本地解 exp 抢着删 cookie，
  // 用户就表现为「点菜单被登出」。现在令牌到期时浏览器自己清 cookie，
  // 会话失效由控制面验签统一判定，不再有本地猜测与不可逆清除。
  const maxAge = sessionMaxAge(token);
  const response = NextResponse.redirect(new URL(next, origin));
  response.cookies.set("weave_platform_token", token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge,
  });
  response.cookies.delete("weave_platform_oidc_state");
  response.cookies.delete("weave_platform_oidc_verifier");
  response.cookies.delete("weave_platform_oidc_next");
  return response;
}
