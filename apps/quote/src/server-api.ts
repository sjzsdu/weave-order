import { headers } from "next/headers";
import { CustomerQuotePage } from "@weave-order/schema";
import { tryResolveQuoteApiBase } from "./api-base";
import type { ApiResult, QuotePageData } from "./api";

/**
 * SSR 读取：服务端直连 API，并把真实访客 IP / UA 透传过去做最小埋点。
 * `track=0` 用于打印页，避免同一次访问被记两次浏览。
 *
 * 失败必须分清两类，因为客户看到的第一句话决定了下一步动作：
 *   - 后端明确回答「过期 / 撤回 / 不存在」→ 原样透传，让客户去找业务员；
 *   - 后端没答上来（连不上、5xx、配置缺失）→ UPSTREAM，客户只会想「等一下再试」。
 * 之前一律压成 INVALID_LINK，一次部署配错就伪装成「所有报价链接都失效」。
 */
export async function fetchQuotePage(
  token: string,
  options: { track?: boolean } = {},
): Promise<ApiResult<QuotePageData>> {
  const resolved = tryResolveQuoteApiBase();
  if (!resolved.ok) {
    // 配置缺失不是这条链接的问题，别让客户去怀疑业务员。
    return { ok: false, error: { code: "UPSTREAM", message: resolved.message } };
  }

  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip") ?? "";
  const userAgent = incoming.get("user-agent") ?? "weave-quote-ssr";
  const query = options.track === false ? "?track=0" : "";

  try {
    const response = await fetch(
      `${resolved.base}/api/public/quotes/${encodeURIComponent(token)}${query}`,
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
      const code = candidate?.error?.code;
      // 只有后端按合同给出的链接状态才算链接状态；其余（5xx / 网关错误页）归 UPSTREAM。
      if (typeof code === "string") {
        return {
          ok: false,
          error: { code: code as never, message: candidate?.error?.message ?? "无法加载报价" },
        };
      }
      console.error(`[quote] SSR ${response.status} ${token ? "quote" : ""} 读取失败`);
      return { ok: false, error: { code: "UPSTREAM", message: "报价服务暂时不可用" } };
    }
    const payload = body as { data: unknown };
    const parsed = CustomerQuotePage.safeParse(payload.data);
    if (!parsed.success) {
      console.error("[quote] SSR 返回体不符合合同", parsed.error.issues.slice(0, 3));
      return { ok: false, error: { code: "UPSTREAM", message: "报价服务暂时不可用" } };
    }
    return { ok: true, data: parsed.data };
  } catch (error) {
    console.error("[quote] SSR 连接 API 失败", error);
    return { ok: false, error: { code: "UPSTREAM", message: "暂时无法加载报价，请稍后重试" } };
  }
}
