import { z } from "zod";
import { ApiError, createApiClient } from "@weave-order/core";
import type { ApiClient } from "@weave-order/core";
import {
  CreateRevisionRequestInput,
  DecideRevisionRequestInput,
  QuoteDetail,
  QuoteShare,
  RevisionRequest,
  T006SuggestLinePriceInput,
  T006SuggestLinePriceResult,
} from "@weave-order/schema";
import type { CreatedQuoteShare } from "@weave-order/schema";
import type { CustomerListItem, CustomerListOptions } from "@weave-order/schema";

/**
 * 移动端 API 面 = `packages/core` 的契约客户端 + 三个尚未进 core 的动作。
 *
 * 未冻结的 HTTP 形状集中在这里（revisions / presign / proof），
 * Track A/E 落地后只需改这一个文件；页面永远不裸 fetch。
 */

export interface PresignInput {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  byteSize: number;
}

export interface PresignResult {
  uploadUrl: string;
  publicUrl: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  formData?: Record<string, string>;
}

export interface ProofInput {
  kind: "SIGNATURE" | "CARGO" | "SAMPLE" | "RECEIPT";
  imageUrl: string;
  trackingNumber?: string;
  note?: string;
}

export interface ProofReceipt {
  id: string;
  recordedAt: string;
}

export interface ShareSummary {
  share: QuoteShare;
  url: string;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface MobileApi extends ApiClient {
  getQuote(quoteId: string): Promise<QuoteDetail>;
  /** 客户列表：`sort` 原样透传给服务端，移动端不二次排序。 */
  customerList(options?: CustomerListOptions): Promise<CustomerListItem[]>;
  /**
   * 建议单价（T-006）：内核按成本底线 + 默认毛利算出建议价，只读不落库。
   * 手机端拿不到成本底线，只能通过这个接口给业务员一个合规起点。
   */
  suggestLinePrice(
    input: z.input<typeof T006SuggestLinePriceInput>,
  ): Promise<z.infer<typeof T006SuggestLinePriceResult>>;
  createRevision(input: z.input<typeof CreateRevisionRequestInput>): Promise<RevisionRequest>;
  decideRevision(input: z.input<typeof DecideRevisionRequestInput>): Promise<RevisionRequest>;
  listQuoteShares(quoteId: string): Promise<ShareSummary[]>;
  presignMedia(input: PresignInput): Promise<PresignResult>;
  recordProof(input: ProofInput): Promise<ProofReceipt>;
  /** 兼容 mock 的显式创建分享（core 已有同签名方法，这里只做类型收口）。 */
  createShare(input: Parameters<ApiClient["createQuoteShare"]>[0]): Promise<CreatedQuoteShare>;
}

export type RequestFn = (
  path: string,
  init?: RequestInit,
  call?: { toolFailure?: boolean },
) => Promise<unknown>;

const ShareSummarySchema = z
  .object({
    share: QuoteShare,
    url: z.string(),
    viewCount: z.number().int().nonnegative(),
    lastViewedAt: z.string().nullable(),
  })
  .passthrough();
const SharesResponse = z.object({ shares: z.array(ShareSummarySchema) }).strict();

const PresignResultSchema = z
  .object({
    uploadUrl: z.string(),
    publicUrl: z.string(),
    method: z.union([z.literal("PUT"), z.literal("POST")]),
    headers: z.record(z.string()).default({}),
    formData: z.record(z.string()).optional(),
  })
  .passthrough();

const ProofReceiptSchema = z.object({ id: z.string(), recordedAt: z.string() }).passthrough();

/**
 * 与 core 相同的失败解析：统一 `{ error: { code, message } }`。
 *
 * `toolFailure`：工具 / 审批面用 body 的 `{ok:false,error}` 表达业务失败，状态码
 * 同时回归 4xx。这类 4xx 不是传输错误，原样交回响应体，调用方的 `result.ok`
 * 判分支继续成立；只对工具路由的调用点打开，其余路由族保持原样。
 */
export function createRequester(
  baseUrl: string,
  fetchImpl: (
    input: string,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
  getToken?: () => string | null | Promise<string | null>,
): RequestFn {
  const base = baseUrl.replace(/\/$/, "");
  return async (path, init = {}, call = {}) => {
    const token = getToken ? await getToken() : null;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${base}${path}`, { ...init, headers });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (response.ok) throw new ApiError(response.status, "INTERNAL", "服务端返回非 JSON 响应");
      throw new ApiError(response.status, "INTERNAL", `请求失败（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      if (call.toolFailure && response.status < 500) {
        const failure = z
          .object({
            ok: z.literal(false),
            error: z.object({ code: z.string(), message: z.string() }).passthrough(),
          })
          .safeParse(json);
        if (failure.success) return json;
      }
      const parsed = z
        .object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() })
        .safeParse(json);
      if (parsed.success) {
        throw new ApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error,
        );
      }
      throw new ApiError(response.status, "INTERNAL", `请求失败（HTTP ${response.status}）`);
    }
    return json;
  };
}

export function createMobileApi(
  baseUrl: string,
  fetchImpl: (
    input: string,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
  getToken: () => string | null | Promise<string | null>,
): MobileApi {
  const request = createRequester(baseUrl, fetchImpl, getToken);
  const core = createApiClient({
    baseUrl,
    getToken,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const post = (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body) });
  return {
    ...core,

    async getQuote(quoteId) {
      return QuoteDetail.parse(await request(`/api/quotes/${encodeURIComponent(quoteId)}`));
    },

    async customerList(options = {}) {
      return core.customerList(options);
    },

    async suggestLinePrice(input) {
      return T006SuggestLinePriceResult.parse(
        await request(
          "/api/tools/suggest-line-price",
          {
            method: "POST",
            body: JSON.stringify(T006SuggestLinePriceInput.parse(input)),
          },
          { toolFailure: true },
        ),
      );
    },

    async createRevision(input) {
      return RevisionRequest.parse(
        await post("/api/revisions", CreateRevisionRequestInput.parse(input)),
      );
    },

    async decideRevision(input) {
      return RevisionRequest.parse(
        await post("/api/revisions/decide", DecideRevisionRequestInput.parse(input)),
      );
    },

    async listQuoteShares(quoteId) {
      return SharesResponse.parse(
        await request(`/api/quote-shares?quoteId=${encodeURIComponent(quoteId)}`),
      ).shares;
    },

    async presignMedia(input) {
      return PresignResultSchema.parse(await post("/api/media/presign", input));
    },

    async recordProof(input) {
      return ProofReceiptSchema.parse(await post("/api/shipments/proof", input));
    },

    async createShare(input) {
      return core.createQuoteShare(input);
    },
  };
}
