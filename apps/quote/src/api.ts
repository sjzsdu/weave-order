import type { CustomerQuotePage, QuoteLinkErrorCode } from "@weave-order/schema";
import { QUOTE_BASE_PATH } from "./base-path";

/**
 * 浏览器侧失败原因。前半是后端合同里的链接状态（`QuoteLinkErrorCode`），
 * 后半是本应用自己的基础设施状态 —— 两者的差别对客户是决定性的：
 * 「链接无效」意味着找业务员要新链接，「服务不可用」意味着等一会儿再试。
 * 曾经所有失败都被压成 INVALID_LINK，一次反代 500 就能让客户以为报价被撤回。
 */
export type ClientErrorCode = QuoteLinkErrorCode | "UPSTREAM";

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: ClientErrorCode; message: string } };

/**
 * 浏览器一律走同源 `/s/api/...`，由 `app/api/[...path]/route.ts` 在运行时反代到
 * `QUOTE_API_BASE_URL`。同源的好处：不需要为公开页开 CORS、不受第三域 Cookie 影响，
 * 且换环境只改服务端 env，不需要重建镜像。
 */
export const API_BASE = `${QUOTE_BASE_PATH}/api`;

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (response.status === 204) return { ok: true, data: undefined as T };
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const candidate = body as { error?: { code?: unknown; message?: unknown } } | null;
      // 5xx / 反代故障不是链接状态，不能报成「链接无效」。
      const fallbackCode: ClientErrorCode = response.status >= 500 ? "UPSTREAM" : "INVALID_LINK";
      const code =
        typeof candidate?.error?.code === "string"
          ? (candidate.error.code as ClientErrorCode)
          : fallbackCode;
      const message =
        typeof candidate?.error?.message === "string"
          ? candidate.error.message
          : `HTTP ${response.status}`;
      return { ok: false, error: { code, message } };
    }
    return { ok: true, data: (body as { data: T }).data };
  } catch {
    // 网络层失败（断网、DNS、超时）同样属于服务可用性，不是链接状态。
    return { ok: false, error: { code: "UPSTREAM", message: "网络异常，请稍后重试" } };
  }
}

export function acceptQuote(token: string, phoneTail?: string) {
  return request<{ acceptedAt: string; alreadyAccepted: boolean; nextStep: string }>(
    `/public/quotes/${encodeURIComponent(token)}/accept`,
    { method: "POST", body: JSON.stringify(phoneTail ? { phoneTail } : {}) },
  );
}

export function askQuestion(token: string, message: string, lineIndex: number | null) {
  return request<{ eventId: string; createdAt: string }>(
    `/public/quotes/${encodeURIComponent(token)}/questions`,
    { method: "POST", body: JSON.stringify({ message, lineIndex }) },
  );
}

export function recordPdfDownload(token: string) {
  return request<void>(`/public/quotes/${encodeURIComponent(token)}/pdf`, { method: "POST" });
}

export type QuotePageData = CustomerQuotePage;
