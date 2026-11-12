import { z } from "zod";
import { ApiError, createApiClient } from "@weave-order/core";
import type { ApiClient } from "@weave-order/core";
import {
  CreateRevisionRequestInput,
  DecideRevisionRequestInput,
  QuoteShare,
  QuoteDraft,
  QuoteStatus,
  RevisionRequest,
  T001SearchFabricByImageResult,
} from "@weave-order/schema";
import type { CreatedQuoteShare } from "@weave-order/schema";

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

export interface QuoteDetail {
  draft: QuoteDraft;
  version: number;
  status: QuoteStatus;
}

export interface MobileApi extends ApiClient {
  getQuote(quoteId: string): Promise<QuoteDetail>;
  /**
   * 以图搜样（直传后按 URL 检索）。
   * 注意：T0 冻结的 T-001 只接受 base64，和「禁止 base64 JSON」冲突；
   * 这里按 imageUrl 调用，待契约增加 URL 变体后即可接真后端。
   */
  searchByImageUrl(imageUrl: string): Promise<T001SearchFabricByImageResult>;
  createRevision(input: z.input<typeof CreateRevisionRequestInput>): Promise<RevisionRequest>;
  decideRevision(input: z.input<typeof DecideRevisionRequestInput>): Promise<RevisionRequest>;
  listQuoteShares(quoteId: string): Promise<ShareSummary[]>;
  presignMedia(input: PresignInput): Promise<PresignResult>;
  recordProof(input: ProofInput): Promise<ProofReceipt>;
  /** 兼容 mock 的显式创建分享（core 已有同签名方法，这里只做类型收口）。 */
  createShare(input: Parameters<ApiClient["createQuoteShare"]>[0]): Promise<CreatedQuoteShare>;
}

export type RequestFn = (path: string, init?: RequestInit) => Promise<unknown>;

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

const QuoteDetailSchema = z
  .object({ draft: QuoteDraft, version: z.number().int().positive(), status: QuoteStatus })
  .passthrough();

/** 与 core 相同的失败解析：统一 `{ error: { code, message } }`。 */
export function createRequester(
  baseUrl: string,
  fetchImpl: (
    input: string,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
  getToken?: () => string | null | Promise<string | null>,
): RequestFn {
  const base = baseUrl.replace(/\/$/, "");
  return async (path, init = {}) => {
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
      return QuoteDetailSchema.parse(await request(`/api/quotes/${encodeURIComponent(quoteId)}`));
    },

    async searchByImageUrl(imageUrl) {
      return T001SearchFabricByImageResult.parse(
        await post("/api/tools/search-by-image", { imageUrl, topK: 5, minSimilarity: 0.3 }),
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
