import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  return (process.env.PLATFORM_API_URL ?? "http://localhost:3002").replace(/\/$/, "");
}

function tokenFromRequest(request: NextRequest): string | null {
  const cookie = request.cookies.get("weave_platform_token")?.value;
  if (cookie) return cookie;
  if (process.env.NODE_ENV !== "production") {
    return process.env.DEV_PLATFORM_TOKEN ?? "dev:owner";
  }
  return null;
}

async function proxy(request: NextRequest, segments: string[]): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  headers.set("x-request-id", requestId);
  const token = tokenFromRequest(request);
  if (!token) {
    return NextResponse.json(
      {
        error: { code: "UNAUTHENTICATED", message: "请先登录平台控制台", requestId },
      },
      { status: 401, headers: { "x-request-id": requestId } },
    );
  }
  headers.set("authorization", `Bearer ${token}`);

  const url = `${targetBase()}/platform/api/${segments.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
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
    // 不把 fetch failed / ECONNREFUSED 之类的底层文案透到页面上。
    console.error("[admin] 控制面不可达", {
      requestId,
      path: segments.join("/"),
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json(
      {
        error: {
          code: "PLATFORM_UNREACHABLE",
          message: "控制面服务暂时不可达，请稍后重试",
          requestId,
        },
      },
      { status: 502, headers: { "x-request-id": requestId } },
    );
  }

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  const upstreamRequestId = upstream.headers.get("x-request-id");
  responseHeaders.set("x-request-id", upstreamRequestId ?? requestId);
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
