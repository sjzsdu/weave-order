import { NextResponse } from "next/server";
import { tryResolveQuoteApiBase } from "@/src/api-base";

/**
 * 浏览器侧 `/s/api/**` 的同源反代。
 *
 * 为什么不用 `next.config.ts` 的 `rewrites`：rewrite 的 destination 在
 * `next build` 时就固化进 `routes-manifest.json`，同一镜像换环境（本地/测试/生产）
 * 只能有一个目标，且运行时改 env 无效 —— 配错的表现是「所有报价链接都显示链接无效」。
 * 这个 route handler 在**每次请求**读 `QUOTE_API_BASE_URL`，所以换 env 重启即生效。
 *
 * 只放行公开报价/样卡接口：这是唯一需要从客户浏览器打到后端的路径。
 * 其它 `/api/**` 一律 404，避免把这层变成后端的通用开放代理。
 */

export const dynamic = "force-dynamic";

const ALLOWED_PREFIXES = ["public/quotes", "public/sample-cards"];
const ALLOWED_METHODS = ["GET", "POST"];

function isAllowed(pathSegments: string[]): boolean {
  const path = pathSegments.join("/");
  return ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function upstreamError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code: "UPSTREAM", message } }, { status });
}

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (!ALLOWED_METHODS.includes(request.method)) {
    return NextResponse.json({ ok: false, error: { message: "方法不允许" } }, { status: 405 });
  }

  const { path } = await context.params;
  if (!isAllowed(path)) {
    return NextResponse.json({ ok: false, error: { message: "接口不存在" } }, { status: 404 });
  }

  const resolved = tryResolveQuoteApiBase();
  if (!resolved.ok) {
    // 503 而不是 404：配置缺失是服务端问题，不能让客户以为链接坏了。
    return upstreamError("报价服务暂时不可用，请稍后重试", 503);
  }

  const url = new URL(request.url);
  const target = `${resolved.base}/api/${path.map(encodeURIComponent).join("/")}${url.search}`;

  // 透传访客 IP / UA：后端按 IP 限流，少了这两个头等于所有人共享一个配额。
  const forwardedFor = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
  const headers: Record<string, string> = {
    accept: request.headers.get("accept") ?? "application/json",
    "user-agent": request.headers.get("user-agent") ?? "weave-quote-proxy",
  };
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  const contentType = request.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      cache: "no-store",
      ...(request.method === "POST" ? { body: await request.text() } : {}),
    });
    // 204/304 不允许带 body：`new Response(buffer, {status:204})` 会直接抛 TypeError，
    // 让后端的「记录 PDF 下载」（POST :token/pdf，HttpCode 204）变成 503。
    const nullBody = upstream.status === 204 || upstream.status === 304;
    const body = nullBody ? null : await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...(nullBody
          ? {}
          : { "content-type": upstream.headers.get("content-type") ?? "application/json" }),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error(`[quote] 反代失败 ${request.method} ${target}`, error);
    return upstreamError("报价服务暂时不可用，请稍后重试", 503);
  }
}

export function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}

export function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}
