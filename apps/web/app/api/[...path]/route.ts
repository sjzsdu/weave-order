import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isProductionLike } from "@/runtime-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 同源 BFF：浏览器只调用 /api/*，OIDC token 只存在 httpOnly Cookie，
 * 由服务端在这里注入 Authorization 后转发给 Nest。
 * 前端脚本拿不到 token；跨域也不需要开放 CORS。
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "content-length",
]);

function targetBase(): string {
  return (process.env.API_PROXY_TARGET ?? "http://localhost:3000").replace(/\/$/, "");
}

function tokenFromRequest(request: NextRequest): string | null {
  const cookie = request.cookies.get("weave_token")?.value;
  if (cookie) return cookie;
  // 本地无 Casdoor 时的开发兜底；生产态绝不回退。
  if (!isProductionLike()) {
    return process.env.DEV_AUTH_TOKEN ?? "dev:demo:demo";
  }
  return null;
}

async function proxy(request: NextRequest, segments: string[]): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  const token = tokenFromRequest(request);
  if (token) headers.set("authorization", `Bearer ${token}`);

  /*
   * 租户会话：网关用 httpOnly Cookie 记住「登录后选了哪家公司」。
   * 浏览器 → Next 这一跳是同源，Next → Nest 是服务端转发，所以要显式带上；
   * 回程的 Set-Cookie 也要原样透传，否则切换租户后浏览器永远停留在旧会话。
   */
  const sid = request.cookies.get("weave_sid")?.value;
  if (sid) headers.set("cookie", `weave_sid=${sid}`);

  const url = `${targetBase()}/api/${segments.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
      redirect: "manual",
    });
  } catch (cause) {
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL",
          message: cause instanceof Error ? cause.message : "后端不可达",
        },
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) responseHeaders.set("retry-after", retryAfter);
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxy(request, path ?? []);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
