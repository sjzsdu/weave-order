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
  const token = tokenFromRequest(request);
  if (!token) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "请先登录平台控制台" } },
      { status: 401 },
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
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL",
          message: cause instanceof Error ? cause.message : "控制面不可达",
        },
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
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
