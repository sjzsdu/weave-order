import type { CustomerQuotePage, QuoteLinkErrorCode } from "@weave-order/schema";

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: QuoteLinkErrorCode; message: string } };

/**
 * 浏览器直连 API。生产默认同源（`/api` 反代到后端），本地默认 API :3000；
 * 若前后端不同域，用 `NEXT_PUBLIC_QUOTE_API_BASE_URL` 显式指定。
 */
export const API_BASE =
  process.env.NEXT_PUBLIC_QUOTE_API_BASE_URL ??
  (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");

const NETWORK_ERROR: ApiResult<never> = {
  ok: false,
  error: { code: "INVALID_LINK", message: "网络异常，请稍后重试" },
};

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
      const code =
        typeof candidate?.error?.code === "string" ? candidate.error.code : "INVALID_LINK";
      const message =
        typeof candidate?.error?.message === "string"
          ? candidate.error.message
          : `HTTP ${response.status}`;
      return { ok: false, error: { code: code as QuoteLinkErrorCode, message } };
    }
    return { ok: true, data: (body as { data: T }).data };
  } catch {
    return NETWORK_ERROR;
  }
}

export function acceptQuote(token: string, phoneTail?: string) {
  return request<{ acceptedAt: string; alreadyAccepted: boolean; nextStep: string }>(
    `/api/public/quotes/${encodeURIComponent(token)}/accept`,
    { method: "POST", body: JSON.stringify(phoneTail ? { phoneTail } : {}) },
  );
}

export function askQuestion(token: string, message: string, lineIndex: number | null) {
  return request<{ eventId: string; createdAt: string }>(
    `/api/public/quotes/${encodeURIComponent(token)}/questions`,
    { method: "POST", body: JSON.stringify({ message, lineIndex }) },
  );
}

export function recordPdfDownload(token: string) {
  return request<void>(`/api/public/quotes/${encodeURIComponent(token)}/pdf`, { method: "POST" });
}

export type QuotePageData = CustomerQuotePage;
