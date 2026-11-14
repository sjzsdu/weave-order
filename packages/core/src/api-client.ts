import { z } from "zod";
import {
  ApprovalDetail,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalQueue,
  AuthMeResponse,
  AuthContextResponse,
  CreatedQuoteShare,
  CreateQuoteShareInput,
  CreateSampleInput,
  CreateSampleShipmentInput,
  CreateBoxesInput,
  CreatePrintJobInput,
  CreateShipmentInput,
  Customer,
  FabricSample,
  InviteMemberInput,
  InvitePreview,
  Order,
  OnboardingPreview,
  OnboardingResult,
  StartTenantInput,
  TeamInvite,
  TeamInviteList,
  OrderShippingSummary,
  PanoramaSnapshot,
  PrintCenterSnapshot,
  PrintDevices,
  PrintJob,
  PrintJobBatchResult,
  PrintJobList,
  PrintLogList,
  PrintTemplateList,
  PublishPrintTemplateInput,
  PublishPrintTemplateVersionInput,
  PickScanInput,
  QuoteShareStats,
  QuoteShareStatsList,
  RegisterPrintAgentInput,
  ScanResult,
  SampleImage,
  Shipment,
  ShipmentView,
  T002SearchFabricBySpecInput,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftInput,
  T004GenerateQuoteDraftResult,
  T005CreateSampleShipmentResult,
  SwitchTenantInput,
  TenantChoicesResponse,
  UpdateSampleInput,
  VerifyScanInput,
} from "@weave-order/schema";
import type { ApprovalKind, ReprintReason, SampleStatus } from "@weave-order/schema";

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

export interface SampleListParams {
  query?: string | null;
  category?: string | null;
  status?: SampleStatus | "ALL" | null;
  cursor?: string | null;
  limit?: number;
}

export interface PresignImageInput {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  byteSize: number;
  /** 绑定到已有样品；不传时 key 落在 `uploads/`，需随样品创建一起提交。 */
  sampleId?: string;
}

export interface PresignImageResult {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  objectKey: string;
  expiresAt: string;
}

export interface ConfirmImageInput {
  objectKey: string;
  isPrimary?: boolean;
  sortOrder?: number;
  width?: number;
  height?: number;
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
const SamplePageResponse = z
  .object({
    samples: z.array(FabricSample),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    categories: z.array(z.string()),
  })
  .strict();
const SampleResponse = z.object({ sample: FabricSample }).strict();
const PresignImageResponse = z
  .object({
    uploadUrl: z.string().url(),
    method: z.literal("PUT"),
    headers: z.record(z.string()),
    objectKey: z.string(),
    expiresAt: z.string(),
  })
  .strict();
const ConfirmImageResponse = z.object({ image: SampleImage }).strict();
const OrdersResponse = z.object({ orders: z.array(Order) }).strict();
const PendingShippingResponse = z.object({ orders: z.array(OrderShippingSummary) }).strict();
const EnqueuePrintJobResponse = z
  .object({
    job: PrintJob,
    deduplicated: z.boolean(),
    message: z.string(),
  })
  .strict();
const TemplateResponse = z.object({ template: z.unknown() }).passthrough();
const OkQuoteShareStats = z.object({ ok: z.literal(true), data: QuoteShareStats }).strict();
const OkQuoteShareStatsList = z.object({ ok: z.literal(true), data: QuoteShareStatsList }).strict();
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

  /**
   * `toolFailure`：工具 / 审批面用 body 的 `{ok:false,error}` 表达业务失败，
   * 状态码同时回归 4xx。这类 4xx 不是传输错误，原样交回响应体，调用方的
   * `result.ok` 判分支继续成立；5xx（INTERNAL / UPSTREAM_UNAVAILABLE）仍抛
   * ApiError，交给重试与离线队列。只对着工具路由的调用点打开这个开关，
   * 其余路由族（客户分享链接等）各自的 4xx 语义保持原样。
   */
  async function request(
    path: string,
    init: RequestInit = {},
    call: { toolFailure?: boolean } = {},
  ): Promise<unknown> {
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
  }

  const post = (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body) });

  /** 工具 / 审批面：4xx 的业务失败按契约对象交回。 */
  const toolPost = (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body) }, { toolFailure: true });

  return {
    /**
     * 当前登录上下文：已绑定租户（`tenant` + `membership`）或待选择（`MULTI_TENANT`）。
     * 多租户账号在选公司之前也能登录成功，所以这里不再是单一形状。
     */
    me: async () => AuthMeResponse.parse(await request("/api/auth/me")),

    /** 「我的公司」列表：只含该账号自己的成员关系，不含其他成员与业务数据。 */
    tenants: async () => TenantChoicesResponse.parse(await request("/api/auth/tenants")),

    /**
     * 选择 / 切换租户。`tenantId` 只出现在这个请求体里，
     * 服务端校验 membership 后重新绑定会话，前端不保存租户。
     */
    switchTenant: async (input: z.input<typeof SwitchTenantInput>) =>
      AuthContextResponse.parse(await post("/api/auth/switch", SwitchTenantInput.parse(input))),

    /** 登出：吊销服务端会话（幂等），Cookie 由浏览器按响应清除。 */
    logout: async () => {
      await request("/api/auth/session", { method: "DELETE" });
    },

    /** 开通链接预览：打开链接先确认「这是哪家公司、我是不是已经在了」。 */
    previewOnboarding: async (code: string) =>
      OnboardingPreview.parse(
        await request(`/api/onboarding/preview?code=${encodeURIComponent(code)}`),
      ),

    /** 领取开通链接：建公司 + 成为老板；重复调用返回 alreadyActivated。 */
    claimOnboarding: async (code: string) =>
      OnboardingResult.parse(await post("/api/onboarding/claim", { code })),

    /** 自助创建公司：登录后填公司名即可；已有公司时返回那间。 */
    startTenant: async (input: z.input<typeof StartTenantInput>) =>
      OnboardingResult.parse(await post("/api/onboarding/start", input)),

    /** 邀请链接预览：是哪家公司、给什么角色。 */
    previewInvite: async (code: string) =>
      InvitePreview.parse(
        await request(`/api/onboarding/invite/preview?code=${encodeURIComponent(code)}`),
      ),

    /** 接受邀请：绑定到公司，成为正式成员。 */
    acceptInvite: async (code: string) =>
      OnboardingResult.parse(await post("/api/onboarding/invite/accept", { code })),

    /** 待接受与已加入的同事。 */
    listTeam: async () => TeamInviteList.parse(await request("/api/team/invites")).invites,

    /** 本月 credits 用量：1 credit = 1,000 tokens。 */
    creditsUsage: async () =>
      z
        .object({
          period: z.string(),
          creditsIncluded: z.number().nullable(),
          creditsUsed: z.number(),
          percent: z.number(),
          state: z.enum(["OK", "WARN", "PAUSED"]),
        })
        .parse(await request("/api/usage/credits")),

    /** 邀请同事：返回专属链接（由调用方复制发给对方）。 */
    inviteMember: async (input: z.input<typeof InviteMemberInput>) =>
      TeamInvite.parse(await post("/api/team/invites", input)),

    listCustomers: async (limit = 20) =>
      CustomersResponse.parse(await request(`/api/customers?limit=${limit}`)).customers,

    listSamples: async (limit = 50) =>
      SamplesResponse.parse(await request(`/api/samples?limit=${limit}`)).samples,

    /** 样品图墙：游标分页 + 关键词 / 品类 / 状态筛选。 */
    listSamplesPage: async (params: SampleListParams = {}) => {
      const search = new URLSearchParams();
      if (params.query) search.set("query", params.query);
      if (params.category) search.set("category", params.category);
      if (params.status) search.set("status", params.status);
      if (params.cursor) search.set("cursor", params.cursor);
      if (params.limit !== undefined) search.set("limit", String(params.limit));
      const qs = search.toString();
      return SamplePageResponse.parse(await request(`/api/samples${qs ? `?${qs}` : ""}`));
    },

    getSample: async (id: string) =>
      SampleResponse.parse(await request(`/api/samples/${encodeURIComponent(id)}`)).sample,

    createSample: async (input: z.input<typeof CreateSampleInput>) =>
      SampleResponse.parse(await post("/api/samples", CreateSampleInput.parse(input))).sample,

    updateSample: async (id: string, input: z.input<typeof UpdateSampleInput>) =>
      SampleResponse.parse(
        await request(`/api/samples/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(UpdateSampleInput.parse(input)),
        }),
      ).sample,

    archiveSample: async (id: string) =>
      SampleResponse.parse(await post(`/api/samples/${encodeURIComponent(id)}/archive`, {})).sample,

    /** 图片直传第 1 步：拿预签名 URL（key 由服务端生成）。 */
    presignImage: async (input: PresignImageInput) =>
      PresignImageResponse.parse(await post("/api/media/presign", input)),

    /** 图片直传第 3 步：HEAD 校验后写入 `sample_images`。 */
    confirmImage: async (input: ConfirmImageInput) =>
      ConfirmImageResponse.parse(await post("/api/media/confirm", input)).image,

    panorama: async () => PanoramaSnapshot.parse(await request("/api/panorama")),

    /** 审批队列（游标分页）：不传 cursor 即第一页。 */
    approvals: async (options: { cursor?: string | null; limit?: number } = {}) => {
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.cursor) params.set("cursor", options.cursor);
      const qs = params.toString();
      return ApprovalQueue.parse(await request(`/api/approvals${qs ? `?${qs}` : ""}`));
    },

    /** 审批卡详情：出处 / diff / 草稿态由后端只读聚合，前端不推导。 */
    approvalDetail: async (id: string, kind: ApprovalKind) =>
      ApprovalDetail.parse(await request(`/api/approvals/${encodeURIComponent(id)}?kind=${kind}`)),

    audit: async (limit = 50) =>
      AuditResponse.parse(await request(`/api/audit?limit=${limit}`)).entries,

    generateQuoteDraft: async (input: z.input<typeof T004GenerateQuoteDraftInput>) =>
      T004GenerateQuoteDraftResult.parse(
        await toolPost("/api/tools/generate-quote-draft", T004GenerateQuoteDraftInput.parse(input)),
      ),

    searchBySpec: async (input: z.input<typeof T002SearchFabricBySpecInput>) =>
      T002SearchFabricBySpecResult.parse(
        await toolPost("/api/tools/search-by-spec", T002SearchFabricBySpecInput.parse(input)),
      ),

    /** 以图找样：T-001 的 URL 变体（服务端按白名单取图，不接受 base64）。 */
    searchByImageUrl: async (imageUrl: string) =>
      z
        .object({
          ok: z.boolean(),
          data: z.object({
            embeddingModel: z.string(),
            dimension: z.number(),
            matches: z.array(z.object({ sample: FabricSample, score: z.number() })),
          }),
          error: z.object({ code: z.string(), message: z.string() }).optional(),
        })
        .passthrough()
        .parse(
          await post("/api/tools/search-by-image", {
            imageUrl,
            topK: 5,
            minSimilarity: 0.3,
          }),
        ),

    /** 建寄样单（T-005）：只会得到 DRAFT，确认走审批窗口。 */
    createSampleShipment: async (input: z.input<typeof CreateSampleShipmentInput>) =>
      T005CreateSampleShipmentResult.parse(
        await post("/api/tools/create-sample-shipment", CreateSampleShipmentInput.parse(input)),
      ),

    decideApproval: async (input: z.infer<typeof ApprovalDecisionInput>) =>
      ApprovalDecisionResult.parse(
        await toolPost("/api/approvals/decide", ApprovalDecisionInput.parse(input)),
      ),

    createQuoteShare: async (input: z.input<typeof CreateQuoteShareInput>) =>
      CreatedQuoteShare.parse(await post("/api/quote-shares", CreateQuoteShareInput.parse(input))),

    /** 业务员分享面板：访问次数 / 独立访客 / 接受 / 留言聚合。 */
    quoteShareStats: async (quoteId: string) =>
      OkQuoteShareStatsList.parse(
        await request(`/api/quotes/${encodeURIComponent(quoteId)}/shares`),
      ).data.shares,

    revokeQuoteShare: async (shareId: string) =>
      OkQuoteShareStats.parse(await post(`/api/shares/${encodeURIComponent(shareId)}/revoke`, {}))
        .data,

    // ---- 打印中心（E5）----
    orders: async (limit = 50) =>
      OrdersResponse.parse(await request(`/api/orders?limit=${limit}`)).orders,

    order: async (orderId: string) =>
      z.object({ order: Order }).parse(await request(`/api/orders/${orderId}`)).order,

    orderShipments: async (orderId: string) =>
      z
        .object({ shipments: z.array(Shipment) })
        .parse(await request(`/api/orders/${orderId}/shipments`)).shipments,

    shippingPending: async () =>
      PendingShippingResponse.parse(await request("/api/shipping/pending")).orders,

    printCenter: async () => PrintCenterSnapshot.parse(await request("/api/print/center")),

    printJobs: async (status?: string) =>
      PrintJobList.parse(
        await request(`/api/print/jobs${status ? `?status=${encodeURIComponent(status)}` : ""}`),
      ),

    enqueuePrintJob: async (input: z.input<typeof CreatePrintJobInput>) =>
      EnqueuePrintJobResponse.parse(
        await post("/api/print/jobs", CreatePrintJobInput.parse(input)),
      ),

    printShipmentBundle: async (input: {
      shipmentId: string;
      pickingListCopies?: number;
      deliveryNoteCopies?: number;
      boxLabelCopies?: number;
      printerId?: string | null;
      labelPrinterId?: string | null;
    }) => PrintJobBatchResult.parse(await post("/api/print/jobs/bundle", input)),

    cancelPrintJob: async (jobId: string) =>
      z.object({ job: PrintJob }).parse(await post(`/api/print/jobs/${jobId}/cancel`, {})).job,

    retryPrintJob: async (jobId: string) =>
      z.object({ job: PrintJob }).parse(await post(`/api/print/jobs/${jobId}/retry`, {})).job,

    printLogs: async () => PrintLogList.parse(await request("/api/print/logs")).logs,

    printTemplates: async () => PrintTemplateList.parse(await request("/api/print/templates")),

    publishPrintTemplate: async (input: z.input<typeof PublishPrintTemplateInput>) =>
      TemplateResponse.parse(
        await post("/api/print/templates", PublishPrintTemplateInput.parse(input)),
      ).template,

    publishPrintTemplateVersion: async (
      templateId: string,
      input: z.input<typeof PublishPrintTemplateVersionInput>,
    ) =>
      TemplateResponse.parse(
        await post(
          `/api/print/templates/${templateId}/versions`,
          PublishPrintTemplateVersionInput.parse({
            ...input,
            templateId,
          }),
        ),
      ).template,

    printDevices: async () => PrintDevices.parse(await request("/api/print/devices")),

    registerPrintAgent: async (input: z.input<typeof RegisterPrintAgentInput>) =>
      z
        .object({ agent: z.unknown(), token: z.string() })
        .parse(await post("/api/print/devices/agents", RegisterPrintAgentInput.parse(input))),

    disablePrintAgent: async (agentId: string) =>
      post(`/api/print/devices/agents/${agentId}/disable`, {}),

    createShipment: async (
      orderId: string,
      input: Omit<z.input<typeof CreateShipmentInput>, "orderId">,
    ) =>
      z
        .object({ shipment: z.unknown(), view: ShipmentView })
        .parse(
          await post(
            `/api/orders/${orderId}/shipments`,
            CreateShipmentInput.parse({ ...input, orderId }),
          ),
        ),

    shipment: async (shipmentId: string) =>
      ShipmentView.parse(await request(`/api/shipments/${shipmentId}`)),

    shipShipment: async (shipmentId: string) =>
      z
        .object({ shipment: z.unknown(), view: ShipmentView })
        .parse(await post(`/api/shipments/${shipmentId}/ship`, {})),

    createBoxes: async (
      shipmentId: string,
      input: Omit<z.input<typeof CreateBoxesInput>, "shipmentId">,
    ) =>
      z
        .object({ shipment: ShipmentView })
        .passthrough()
        .parse(
          await post(`/api/shipments/${shipmentId}/boxes`, {
            ...CreateBoxesInput.parse({ ...input, shipmentId }),
          }),
        ),

    pickScan: async (
      shipmentId: string,
      input: Omit<z.input<typeof PickScanInput>, "shipmentId">,
    ) =>
      ScanResult.parse(
        await post(
          `/api/shipments/${shipmentId}/pick-scan`,
          PickScanInput.parse({ ...input, shipmentId }),
        ),
      ),

    verifyScan: async (
      shipmentId: string,
      input: Omit<z.input<typeof VerifyScanInput>, "shipmentId">,
    ) =>
      ScanResult.parse(
        await post(
          `/api/shipments/${shipmentId}/verify-scan`,
          VerifyScanInput.parse({ ...input, shipmentId }),
        ),
      ),

    reprintBox: async (
      boxId: string,
      reason: ReprintReason,
      copies = 1,
      printerId?: string | null,
    ) =>
      z
        .object({ shipment: ShipmentView })
        .passthrough()
        .parse(
          await post(`/api/print/boxes/${boxId}/reprint`, {
            reason,
            copies,
            ...(printerId ? { printerId } : {}),
          }),
        ),

    voidBox: async (boxId: string, reason: string) =>
      z
        .object({ shipment: ShipmentView })
        .parse(await post(`/api/print/boxes/${boxId}/void`, { reason })),

    resolveDiscrepancy: async (boxId: string, note: string) =>
      z
        .object({ shipment: ShipmentView })
        .parse(await post(`/api/print/boxes/${boxId}/resolve-discrepancy`, { note })),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
