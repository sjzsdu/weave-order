import { headers } from "next/headers";
import { CustomerQuotePage } from "@weave-order/schema";
import type { ApiResult, QuotePageData } from "./api";

/**
 * SSR 读取：服务端直连 API，并把真实访客 IP / UA 透传过去做最小埋点。
 * `track=0` 用于打印页，避免同一次访问被记两次浏览。
 */
export async function fetchQuotePage(
  token: string,
  options: { track?: boolean } = {},
): Promise<ApiResult<QuotePageData>> {
  const apiBase = process.env.QUOTE_API_BASE_URL ?? "http://localhost:3000";
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip") ?? "";
  const userAgent = incoming.get("user-agent") ?? "weave-quote-ssr";
  const query = options.track === false ? "?track=0" : "";

  try {
    const response = await fetch(
      `${apiBase}/api/public/quotes/${encodeURIComponent(token)}${query}`,
      {
        cache: "no-store",
        headers: {
          "x-forwarded-for": forwarded,
          "user-agent": userAgent,
        },
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const candidate = body as { error?: { code?: string; message?: string } } | null;
      return {
        ok: false,
        error: {
          code: (candidate?.error?.code as never) ?? "INVALID_LINK",
          message: candidate?.error?.message ?? "无法加载报价",
        },
      };
    }
    const payload = body as { data: unknown };
    return { ok: true, data: CustomerQuotePage.parse(payload.data) };
  } catch {
    return {
      ok: false,
      error: { code: "INVALID_LINK", message: "暂时无法加载报价，请稍后重试" },
    };
  }
}
