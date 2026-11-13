import { z } from "zod";
import {
  ApprovalDetail,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalQueue,
  AuthContextResponse,
  CreatedQuoteShare,
  CreateQuoteShareInput,
  CreateBoxesInput,
  CreatePrintJobInput,
  CreateShipmentInput,
  Customer,
  FabricSample,
  Order,
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
  Shipment,
  ShipmentView,
  T002SearchFabricBySpecInput,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftInput,
  T004GenerateQuoteDraftResult,
  VerifyScanInput,
} from "@weave-order/schema";
import type { ApprovalKind, ReprintReason } from "@weave-order/schema";

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
