import { z } from "zod";
import {
  ApprovalDetail,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalQueue,
  AuthMeResponse,
  AuthContextResponse,
  CreatedQuoteShare,
  CreateCustomerRequest,
  CreateQuoteShareInput,
  CreateSampleInput,
  CreateSampleShipmentInput,
  CreateBoxesInput,
  CreatePrintJobInput,
  CreateShipmentInput,
  Customer,
  Customer360,
  CustomerListItem,
  CustomerTimelineKind,
  CustomerTimelinePage,
  DevPersonaListResponse,
  DevSessionInput,
  DemoSceneListResponse,
  DemoSceneResponse,
  FabricSample,
  InboundIntakeInput,
  InboundReplyList,
  InboundReplyResult,
  ImportBatch,
  ImportBatchResult,
  IntentListResponse,
  IntentView,
  SubmitIntentResult,
  InviteMemberInput,
  InvitePreview,
  Order,
  OrderFunnel,
  OrderListResponse,
  OrderWorkbench,
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
  Receivable,
  ReceivableListResponse,
  ReceivablePaymentView,
  ReceivableStatement,
  ScanResult,
  SampleImage,
  Shipment,
  ShipmentView,
  T002SearchFabricBySpecInput,
  T001SearchFabricByImageResult,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftInput,
  T004GenerateQuoteDraftResult,
  T005CreateSampleShipmentResult,
  SubmitIntentInput,
  SwitchTenantInput,
  TenantChoicesResponse,
  UpdateSampleInput,
  VerifyScanInput,
} from "@weave-order/schema";
import type { ApprovalKind, PersonaKey, ReprintReason, SampleStatus } from "@weave-order/schema";

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
  /** 手工录入客户回复的截图：key 落在 `inbound/`，不走 confirm。 */
  purpose?: "inbound";
}

export interface PresignImageResult {
  uploadUrl: string;
  /** 上传后可读地址：CDN 直链，或未配 CDN 时的短期签名 URL。 */
  publicUrl: string;
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
const CustomerResponse = z.object({ customer: Customer }).strict();
const CustomerListResponse = z.object({ customers: z.array(CustomerListItem) }).strict();
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
const ConfirmImageResponse = z.object({ image: SampleImage }).strict();
const RecordPaymentResponse = z
  .object({ receivable: Receivable, payment: ReceivablePaymentView.nullable() })
  .strict();
/** 只拼有值的查询参数，避免把 `undefined` 聊给服务端。 */
function listParams(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

const PresignImageResponse = z
  .object({
    uploadUrl: z.string().url(),
    publicUrl: z.string().url(),
    method: z.literal("PUT"),
    headers: z.record(z.string()),
    objectKey: z.string(),
    expiresAt: z.string(),
  })
  .strict();
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

    /**
     * 本地 dev 的 persona 目录 / 切换（WAN-136）。
     *
     * 这两个路由只在 AUTH_MODE=dev 存在；生产态调用会得到 404，身份条据此隐藏。
     * 请求体只有 personaKey：角色、范围、租户都由服务端按目录和 membership 决定。
     */
    devPersonas: async () =>
      DevPersonaListResponse.parse(await request("/api/dev/personas")).personas,

    devSwitchPersona: async (personaKey: PersonaKey) =>
      AuthContextResponse.parse(
        await post("/api/dev/session", DevSessionInput.parse({ personaKey })),
      ),

    /**
     * 演示剧本（`data/demo-scenes.json`）：生产环境路由不存在。
     * 深链 `/today?scene=<key>` 只取单条，避免每页多拉一份清单。
     */
    demoScenes: async () => DemoSceneListResponse.parse(await request("/api/demo/scenes")).scenes,

    demoScene: async (key: string) =>
      DemoSceneResponse.parse(await request(`/api/demo/scenes/${encodeURIComponent(key)}`)).scene,

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

    /** 撤销待接受的邀请：删除成员行，邀请链接立即失效（已加入的成员不可撤销）。 */
    revokeInvite: async (membershipId: string) => {
      await request(`/api/team/invites/${encodeURIComponent(membershipId)}`, {
        method: "DELETE",
      });
    },

    listCustomers: async (limit = 20) =>
      CustomersResponse.parse(await request(`/api/customers?limit=${limit}`)).customers,

    /** 客户列表（全景 → 客户）：后端聚合未决报价 / 在途寄样 / 应收余额。 */
    customerList: async (
      options: {
        query?: string;
        owner?: "mine" | "all";
        tier?: string;
        overdueOnly?: boolean;
        limit?: number;
      } = {},
    ) => {
      const params = new URLSearchParams();
      if (options.query) params.set("query", options.query);
      if (options.owner) params.set("owner", options.owner);
      if (options.tier) params.set("tier", options.tier);
      if (options.overdueOnly) params.set("overdue", "1");
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      return CustomerListResponse.parse(await request(`/api/customers${qs ? `?${qs}` : ""}`))
        .customers;
    },

    /** 客户 360 首屏：档案 + 上下文 + 汇总。 */
    customer360: async (customerId: string) =>
      Customer360.parse(await request(`/api/customers/${encodeURIComponent(customerId)}`)),

    /**
     * 新建客户。`code` 可以省略，由服务端生成 `CYYMMDD-NNNN`；
     * 负责人与租户由登录态注入，这里不传。
     */
    createCustomer: async (input: z.input<typeof CreateCustomerRequest>) =>
      CustomerResponse.parse(await post("/api/customers", CreateCustomerRequest.parse(input)))
        .customer,

    /** 批量导入（整批原子）：逐行回执由服务端给出，前端只展示。 */
    importBatch: async (batch: z.input<typeof ImportBatch>) =>
      ImportBatchResult.parse(await post("/api/import", ImportBatch.parse(batch))),

    /** 客户时间线（游标分页）。 */
    customerTimeline: async (
      customerId: string,
      options: { kinds?: CustomerTimelineKind[]; limit?: number; cursor?: string | null } = {},
    ) => {
      const params = new URLSearchParams();
      if (options.kinds && options.kinds.length > 0) params.set("types", options.kinds.join(","));
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.cursor) params.set("cursor", options.cursor);
      const qs = params.toString();
      return CustomerTimelinePage.parse(
        await request(
          `/api/customers/${encodeURIComponent(customerId)}/timeline${qs ? `?${qs}` : ""}`,
        ),
      );
    },

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

    /**
     * 单张图重试：服务端同步重跑缩略图 / 向量索引，返回刷新后的整份样品。
     * 失败不会变成 HTTP 错误（图仍挂在样品上），失败原因在 `thumbError` / `indexError`。
     */
    retrySampleImage: async (sampleId: string, imageId: string) =>
      SampleResponse.parse(
        await post(
          `/api/samples/${encodeURIComponent(sampleId)}/images/${encodeURIComponent(imageId)}/retry`,
          {},
        ),
      ).sample,

    /** 图片直传第 1 步：拿预签名 URL（key 由服务端生成）。 */
    presignImage: async (input: PresignImageInput) =>
      PresignImageResponse.parse(await post("/api/media/presign", input)),

    /** 图片直传第 3 步：HEAD 校验后写入 `sample_images`。 */
    confirmImage: async (input: ConfirmImageInput) =>
      ConfirmImageResponse.parse(await post("/api/media/confirm", input)).image,

    /**
     * 手工录入客户回复：文本直接提交，截图先 presign(purpose=inbound) 直传再提交 objectKey。
     * 返回入库行 + 识别结论 + 可能生成的报价草稿 id。
     */
    ingestInboundReply: async (input: z.input<typeof InboundIntakeInput>) =>
      InboundReplyResult.parse(await post("/api/inbound/replies", input)),

    /** 某客户最近录入的回复。 */
    inboundReplies: async (customerId: string, limit = 20) =>
      InboundReplyList.parse(
        await request(
          `/api/inbound/replies?customerId=${encodeURIComponent(customerId)}&limit=${limit}`,
        ),
      ).messages,

    /**
     * 意图通道：提交一句话 → 立刻拿到可追踪的 intentId。
     * `clientRequestId` 由调用方生成并复用，重复提交命中同一条记录（幂等）。
     */
    submitIntent: async (input: z.input<typeof SubmitIntentInput>) =>
      SubmitIntentResult.parse(await post("/api/intents", SubmitIntentInput.parse(input))),

    /** 近期意图（最新在前）：刷新页面后依然能看到刚才说了什么、进展到哪。 */
    intents: async (limit = 20) =>
      IntentListResponse.parse(await request(`/api/intents?limit=${limit}`)).items,

    intent: async (id: string) => {
      const body = (await request(`/api/intents/${encodeURIComponent(id)}`)) as {
        intent: unknown;
      };
      return IntentView.parse(body.intent);
    },

    cancelIntent: async (id: string) =>
      IntentView.parse(
        (
          (await post(`/api/intents/${encodeURIComponent(id)}/cancel`, {})) as {
            intent: unknown;
          }
        ).intent,
      ),

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

    /**
     * 以图找样：T-001 的 URL 变体（服务端按白名单取图，不接受 base64）。
     * 阈值用服务端默认（图-图 0.75）：0.3 那种老值会把不同面料放进来。
     */
    searchByImageUrl: async (imageUrl: string) =>
      T001SearchFabricByImageResult.parse(
        await post("/api/tools/search-by-image", { imageUrl, topK: 5 }),
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

    // ---- 订单 / 应收工作面 ----
    /** 订单列表：筛选 + 游标分页，逾期与已发未发由服务端派生。 */
    orders: async (
      options: {
        limit?: number;
        cursor?: string | null;
        statuses?: readonly string[];
        customerId?: string;
        dueFrom?: string;
        dueBefore?: string;
        overdueOnly?: boolean;
      } = {},
    ) => {
      const params = listParams({
        limit: options.limit,
        cursor: options.cursor,
        customerId: options.customerId,
        dueFrom: options.dueFrom,
        dueBefore: options.dueBefore,
        overdueOnly: options.overdueOnly ? "true" : undefined,
        status: options.statuses?.length ? options.statuses.join(",") : undefined,
      });
      return OrderListResponse.parse(await request(`/api/orders${params}`));
    },

    /** 漏斗：与列表共用筛选（除状态外），数字点进去条数一致。 */
    orderFunnel: async (
      options: {
        customerId?: string;
        dueFrom?: string;
        dueBefore?: string;
        overdueOnly?: boolean;
      } = {},
    ) =>
      OrderFunnel.parse(
        await request(
          `/api/orders/funnel${listParams({
            customerId: options.customerId,
            dueFrom: options.dueFrom,
            dueBefore: options.dueBefore,
            overdueOnly: options.overdueOnly ? "true" : undefined,
          })}`,
        ),
      ),

    /** 订单详情工作面：行项目 / 关联报价 / 寄样记录 / 发货记录。 */
    orderWorkbench: async (orderId: string) =>
      OrderWorkbench.parse(await request(`/api/orders/${encodeURIComponent(orderId)}/workbench`)),

    /** 应收列表：逾期 / 本月到期 / 已结清 + 各分组计数与未收余额。 */
    receivables: async (
      options: {
        bucket?: "overdue" | "dueSoon" | "settled" | "all";
        customerId?: string;
        cursor?: string | null;
        limit?: number;
      } = {},
    ) =>
      ReceivableListResponse.parse(
        await request(
          `/api/receivables${listParams({
            bucket: options.bucket,
            customerId: options.customerId,
            cursor: options.cursor,
            limit: options.limit,
          })}`,
        ),
      ),

    /** 登记回款：金额整数分，日期与凭证可选，成功后返回最新余额。 */
    recordPayment: async (
      receivableId: string,
      input: {
        amount: { amount: number; currency: string };
        paidAt?: string;
        note?: string | null;
        proofObjectKey?: string | null;
      },
    ) =>
      RecordPaymentResponse.parse(
        await post(`/api/receivables/${encodeURIComponent(receivableId)}/payments`, input),
      ),

    /** 客户对账单：一笔应收一行、一笔回款一行，打印与页面同一份汇总。 */
    statement: async (customerId: string, range: { from?: string; to?: string } = {}) =>
      ReceivableStatement.parse(
        await request(
          `/api/customers/${encodeURIComponent(customerId)}/statement${listParams(range)}`,
        ),
      ),

    /** 回款凭证上传：先拿服务端签出的 PUT 地址，客户端直传对象存储。 */
    presignReceipt: async (input: {
      receivableId: string;
      mimeType: "image/jpeg" | "image/png" | "image/webp";
      byteSize: number;
    }) => PresignImageResponse.parse(await post("/api/media/presign", input)),

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
