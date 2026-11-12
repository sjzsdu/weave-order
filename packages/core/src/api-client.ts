import { z } from "zod";
import {
  ApprovalDetail,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalQueue,
  AuthContextResponse,
  CreatedQuoteShare,
  CreateQuoteShareInput,
  Customer,
  FabricSample,
  PanoramaSnapshot,
  T002SearchFabricBySpecInput,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftInput,
  T004GenerateQuoteDraftResult,
} from "@weave-order/schema";
import type { ApprovalKind } from "@weave-order/schema";

/**
 * 前端唯一 API 入口。
 *
 * 铁律：所有调用从这里走（不在页面里裸 fetch）；客户端只做
 * 「携带令牌 + 解析契约」，不计算金额、不判断权限、不传 tenant_id。
 */
export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const CustomersResponse = z.object({ customers: z.array(Customer) }).strict();
const SamplesResponse = z.object({ samples: z.array(FabricSample) }).strict();
const AuditResponse = z.object({
  entries: z.array(
    z
      .object({
        id: z.string(),
        action: z.string(),
        entityType: z.string(),
        entityId: z.string(),
        actorType: z.string(),
        actorId: z.string(),
        createdAt: z.string(),
      })
      .passthrough(),
  ),
});

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await options.getToken();
    // 不用 `Headers` 构造器：小程序运行时没有 DOM 的 Headers，端侧注入的
    // fetch 适配器只认普通键值对象。
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.headers !== undefined && !(init.headers instanceof Array)) {
      const raw = init.headers as Record<string, string>;
      for (const key of Object.keys(raw)) {
        const value = raw[key];
        if (typeof value === "string") headers[key] = value;
      }
    }
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await doFetch(`${base}${path}`, { ...init, headers });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
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
  }

  const post = (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body) });

  return {
    me: async () => AuthContextResponse.parse(await request("/api/auth/me")),

    listCustomers: async (limit = 20) =>
      CustomersResponse.parse(await request(`/api/customers?limit=${limit}`)).customers,

    listSamples: async (limit = 50) =>
      SamplesResponse.parse(await request(`/api/samples?limit=${limit}`)).samples,

    panorama: async () => PanoramaSnapshot.parse(await request("/api/panorama")),

    approvals: async () => ApprovalQueue.parse(await request("/api/approvals")),

    /** 审批卡详情：出处 / diff / 草稿态由后端只读聚合，前端不推导。 */
    approvalDetail: async (id: string, kind: ApprovalKind) =>
      ApprovalDetail.parse(
        await request(`/api/approvals/${encodeURIComponent(id)}?kind=${kind}`),
      ),

    audit: async (limit = 50) =>
      AuditResponse.parse(await request(`/api/audit?limit=${limit}`)).entries,

    generateQuoteDraft: async (input: z.input<typeof T004GenerateQuoteDraftInput>) =>
      T004GenerateQuoteDraftResult.parse(
        await post("/api/tools/generate-quote-draft", T004GenerateQuoteDraftInput.parse(input)),
      ),

    searchBySpec: async (input: z.input<typeof T002SearchFabricBySpecInput>) =>
      T002SearchFabricBySpecResult.parse(
        await post("/api/tools/search-by-spec", T002SearchFabricBySpecInput.parse(input)),
      ),

    decideApproval: async (input: z.infer<typeof ApprovalDecisionInput>) =>
      ApprovalDecisionResult.parse(
        await post("/api/approvals/decide", ApprovalDecisionInput.parse(input)),
      ),

    createQuoteShare: async (input: z.input<typeof CreateQuoteShareInput>) =>
      CreatedQuoteShare.parse(await post("/api/quote-shares", CreateQuoteShareInput.parse(input))),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
