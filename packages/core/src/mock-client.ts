import {
  ApprovalDetail,
  ApprovalDecisionResult,
  ApprovalQueue,
  AuthContextResponse,
  TenantChoicesResponse,
  CreatedQuoteShare,
  PrintCenterSnapshot,
  PrintDevices,
  PrintJobList,
  PrintLogList,
  PrintTemplateList,
  PanoramaSnapshot,
  QuoteShareStats,
  QuoteShareStatsList,
  ShipmentView,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftResult,
} from "@weave-order/schema";
import type { ApprovalDecisionInput } from "@weave-order/schema";
import type { ApiClient } from "./api-client";

/**
 * 演示 / 离线 mock transport。
 *
 * 只在「没有后端」的本地预览里使用：接口形状与 `createApiClient` 完全一致，
 * 页面逻辑与真实联调零差异（T0 §5 mock 口径）。
 * 它不参与任何生产判断：批准仍要真实后端 confirm 才生效。
 */

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const SAMPLE_ID = "33333333-3333-4333-8333-333333333333";
const QUOTE_ID = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP_ID = "55555555-5555-4555-8555-555555555555";
const AUDIT_ID = "66666666-6666-4666-8666-666666666666";
const REVISION_ID = "77777777-7777-4777-8777-777777777777";
const SHIPMENT_ID = "88888888-8888-4888-8888-888888888888";

const NOW = "2026-11-12T09:00:00.000Z";
const EXPIRES = "2026-11-26T09:00:00.000Z";

const customer = {
  id: CUSTOMER_ID,
  tenantId: TENANT_ID,
  code: "KH-018",
  name: "杭州青禾服饰",
  tier: "VIP" as const,
  contactName: "周敏",
  contactPhone: "138****6621",
  contactEmail: "zhoumin@example.com",
};

const sample = {
  id: SAMPLE_ID,
  tenantId: TENANT_ID,
  code: "FM-220",
  name: "32S 精梳棉汗布 220g",
  composition: "100% 棉",
  weight: "220g/m²",
  unit: "meter" as const,
  costFloor: { amount: 1420, currency: "CNY" as const },
  status: "ACTIVE" as const,
  createdAt: NOW,
};

const item = {
  id: QUOTE_ID,
  kind: "quote" as const,
  title: "报价 · 杭州青禾服饰",
  summary: "500 米 × ¥15.20 · 合计 ¥7,600.00",
  status: "DRAFT" as const,
  pending: true,
  amountCents: 760000,
  currency: "CNY" as const,
  customerId: CUSTOMER_ID,
  createdAt: NOW,
  confirmedBy: null,
};

const detail = ApprovalDetail.parse({
  item,
  customer,
  draft: { state: "DRAFT", version: 2, revisedByHuman: true, revisionCount: 1 },
  lines: [
    {
      id: "line-1",
      description: "32S 精梳棉汗布 220g 本白",
      quantity: { value: 500, unit: "meter" },
      unitPrice: { amount: 1520, currency: "CNY" },
      lineTotal: { amount: 760000, currency: "CNY" },
    },
  ],
  subtotal: { amount: 760000, currency: "CNY" },
  total: { amount: 760000, currency: "CNY" },
  currency: "CNY",
  provenance: [
    {
      id: "history",
      kind: "HISTORY",
      label: "历史成交",
      value: "15.00 / 15.40 / 15.20",
      detail: "该客户过去 3 次成交价；本次 15.20 与最近一次持平。",
      sourceRef: null,
    },
    {
      id: "cost",
      kind: "COST",
      label: "成本底线",
      value: "¥14.20",
      detail: "坯布 11.80 + 染费 1.40 = 13.20；管控底线 14.20（硬边界）。",
      sourceRef: null,
    },
    {
      id: "stock",
      kind: "STOCK",
      label: "库存",
      value: "1,200 米现货",
      detail: "32S 精梳棉 220g 现货可覆盖本次 500 米。",
      sourceRef: null,
    },
  ],
  diffs: [{ field: "第 1 行单价 · v2", before: 1560, after: 1520 }],
  missingFields: [{ field: "deliveryDate", label: "交期", hint: "确认后报价才算完整" }],
  risk: { level: "MEDIUM", reasons: ["距成本底线 7%"] },
  audit: [
    {
      id: AUDIT_ID,
      tenantId: TENANT_ID,
      seq: 8,
      actorType: "AGENT",
      actorId: "agent:xiao-zhi",
      action: "QUOTE_DRAFT_GENERATED",
      entityType: "quote",
      entityId: QUOTE_ID,
      before: null,
      after: { total: 780000 },
      correlationId: null,
      createdAt: NOW,
    },
    {
      id: REVISION_ID,
      tenantId: TENANT_ID,
      seq: 9,
      actorType: "HUMAN",
      actorId: "user:owner",
      action: "REVISION_REQUESTED",
      entityType: "quote",
      entityId: QUOTE_ID,
      before: null,
      after: null,
      correlationId: null,
      createdAt: "2026-11-12T09:05:00.000Z",
    },
  ],
});

const auditEntry = detail.audit[0]!;

const draft = {
  id: QUOTE_ID,
  tenantId: TENANT_ID,
  customerId: CUSTOMER_ID,
  status: "DRAFT" as const,
  currency: "CNY" as const,
  items: [
    {
      fabricSampleId: SAMPLE_ID,
      description: sample.name,
      quantity: { value: 500, unit: "meter" as const },
      unitPrice: { amount: 1520, currency: "CNY" as const },
      lineTotal: { amount: 760000, currency: "CNY" as const },
    },
  ],
  subtotal: { amount: 760000, currency: "CNY" as const },
  total: { amount: 760000, currency: "CNY" as const },
  amountsComputedByKernel: true as const,
  validityDays: 15,
  expiresAt: EXPIRES,
  createdAt: NOW,
  remarks: null,
};

/**
 * 创建 mock client。返回类型就是真实 `ApiClient`，页面无需区分。
 * `decided` 只影响 mock 内的展示，不冒充真实落账。
 */
export function createMockApiClient(): ApiClient {
  let current = detail;
  let audit = detail.audit;

  const toDetail = (input: ApprovalDecisionInput, status: "SENT" | "REJECTED"): ApprovalDetail =>
    ApprovalDetail.parse({
      ...current,
      item: {
        ...current.item,
        pending: false,
        status,
        confirmedBy: input.decision === "APPROVE" ? "user:owner" : null,
      },
      draft: {
        ...current.draft,
        state: input.decision === "APPROVE" ? "CONFIRMED" : "REJECTED",
      },
    });

  const mockMe = (): AuthContextResponse =>
    AuthContextResponse.parse({
      subject: "demo-owner",
      name: "孙巨中",
      email: "owner@example.com",
      tenant: {
        id: TENANT_ID,
        slug: "demo",
        name: "青禾纺织（演示）",
        brand: "青禾",
        bank: null,
        currency: "CNY",
        settings: {},
        status: "ACTIVE",
        isolationMode: "SHARED_RLS",
        createdAt: NOW,
        updatedAt: NOW,
      },
      membership: {
        id: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        subject: "demo-owner",
        casdoorOrg: "demo",
        role: "OWNER",
        dataScope: "ALL",
        teamId: null,
        approvalLimitAmount: null,
        status: "ACTIVE",
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

  return {
    previewOnboarding: () =>
      Promise.reject(new Error("演示模式不支持开通，请用真实账号打开开通链接")),
    claimOnboarding: () =>
      Promise.reject(new Error("演示模式不支持开通，请用真实账号打开开通链接")),
    startTenant: () => Promise.reject(new Error("演示模式不支持创建公司，请用真实账号")),
    previewInvite: () => Promise.reject(new Error("演示模式不支持邀请，请用真实账号")),
    acceptInvite: () => Promise.reject(new Error("演示模式不支持邀请，请用真实账号")),
    listTeam: () => Promise.resolve([]),
    inviteMember: () => Promise.reject(new Error("演示模式不支持邀请，请用真实账号")),
    me: () => Promise.resolve(mockMe()),

    /** 演示模式只有一个租户：选择器永远不出现，切租户直接返回当前上下文。 */
    tenants: () =>
      Promise.resolve(
        TenantChoicesResponse.parse({
          status: "MULTI_TENANT",
          subject: "demo-owner",
          name: "孙巨中",
          email: "owner@example.com",
          tenants: [
            {
              tenantId: TENANT_ID,
              slug: "demo",
              name: "青禾纺织（演示）",
              brand: "青禾",
              role: "OWNER",
              tenantStatus: "ACTIVE",
              membershipStatus: "ACTIVE",
              available: true,
            },
          ],
        }),
      ),

    switchTenant: () => Promise.resolve(mockMe()),

    logout: () => Promise.resolve(),

    listCustomers: () => Promise.resolve([customer]),

    listSamples: () => Promise.resolve([sample]),

    panorama: () =>
      Promise.resolve(
        PanoramaSnapshot.parse({
          generatedAt: NOW,
          customers: [customer],
          samples: [sample],
          items: [current.item],
          audit: [auditEntry],
          stats: {
            customerCount: 12,
            sampleCount: 48,
            quoteCount: 7,
            shipmentCount: 3,
            pendingCount: current.item.pending ? 1 : 0,
            sentQuoteCount: 5,
            confirmedShipmentCount: 2,
            rejectedCount: 0,
            auditCount: 30,
          },
        }),
      ),

    approvals: () =>
      Promise.resolve(ApprovalQueue.parse({ items: current.item.pending ? [current.item] : [] })),

    approvalDetail: (id) => {
      if (id !== QUOTE_ID) {
        return Promise.reject(new Error("NOT_FOUND"));
      }
      return Promise.resolve(current);
    },

    audit: () => Promise.resolve(audit),

    searchBySpec: () =>
      Promise.resolve(
        T002SearchFabricBySpecResult.parse({
          ok: true,
          data: { matches: [{ sample, score: 1, matchedOn: ["name"] }] },
        }),
      ),

    generateQuoteDraft: (_input: Parameters<ApiClient["generateQuoteDraft"]>[0]) =>
      Promise.resolve(T004GenerateQuoteDraftResult.parse({ ok: true, data: { draft } })),

    decideApproval: (input) => {
      current = toDetail(input, input.decision === "APPROVE" ? "SENT" : "REJECTED");
      audit = [
        {
          ...auditEntry,
          id: REVISION_ID,
          seq: 10,
          actorType: "HUMAN",
          action: input.decision === "APPROVE" ? "QUOTE_CONFIRMED" : "QUOTE_REJECTED",
        },
        ...audit,
      ];
      return Promise.resolve(
        ApprovalDecisionResult.parse({
          ok: true,
          data: {
            id: input.id,
            kind: input.kind,
            decision: input.decision,
            status: current.item.status,
            actorType: "HUMAN",
            decidedAt: new Date().toISOString(),
          },
        }),
      );
    },

    createQuoteShare: () =>
      Promise.resolve(
        CreatedQuoteShare.parse({
          share: {
            id: REVISION_ID,
            tenantId: TENANT_ID,
            quoteId: QUOTE_ID,
            version: 2,
            tokenHash: "a".repeat(64),
            expiresAt: EXPIRES,
            requirePhoneTail: false,
            allowPdf: true,
            revokedAt: null,
            createdBy: "demo-owner",
            createdAt: NOW,
          },
          token: "demo".padEnd(40, "0"),
          url: "https://app.weaveorder.cn/s/demo",
        }),
      ),

    quoteShareStats: () =>
      Promise.resolve(
        QuoteShareStatsList.parse({
          quoteId: QUOTE_ID,
          shares: [
            {
              shareId: REVISION_ID,
              quoteId: QUOTE_ID,
              version: 2,
              url: null,
              createdAt: NOW,
              expiresAt: EXPIRES,
              revokedAt: null,
              requirePhoneTail: false,
              allowPdf: true,
              viewCount: 3,
              uniqueVisitors: 2,
              pdfDownloadCount: 1,
              questionCount: 1,
              acceptedAt: null,
              lastViewedAt: NOW,
              lastActivityAt: NOW,
              questions: [
                {
                  eventId: REVISION_ID,
                  message: "这个克重有没有更厚的？（mock）",
                  lineIndex: 0,
                  createdAt: NOW,
                },
              ],
            },
          ],
        }).shares,
      ),

    revokeQuoteShare: () =>
      Promise.resolve(
        QuoteShareStats.parse({
          shareId: REVISION_ID,
          quoteId: QUOTE_ID,
          version: 2,
          url: null,
          createdAt: NOW,
          expiresAt: EXPIRES,
          revokedAt: NOW,
          requirePhoneTail: false,
          allowPdf: true,
          viewCount: 3,
          uniqueVisitors: 2,
          pdfDownloadCount: 1,
          questionCount: 0,
          acceptedAt: null,
          lastViewedAt: NOW,
          lastActivityAt: NOW,
          questions: [],
        }),
      ),

    // ---- 打印中心（demo 没有代理与任务，保持空态；真实写入一律走后端） ----
    orders: () => Promise.resolve([]),

    order: () => Promise.reject(new Error("演示模式没有订单详情")),

    orderShipments: () => Promise.resolve([]),

    shippingPending: () => Promise.resolve([]),

    printCenter: () =>
      Promise.resolve(
        PrintCenterSnapshot.parse({
          queue: { jobs: [], counts: { queued: 0, failed: 0, done: 0 } },
          templates: [],
          devices: { agents: [], printers: [] },
          logs: [],
          pendingShipments: [],
        }),
      ),

    printJobs: () =>
      Promise.resolve(PrintJobList.parse({ jobs: [], counts: { queued: 0, failed: 0, done: 0 } })),

    enqueuePrintJob: () => Promise.reject(new Error("演示模式不实际打印")),
    printShipmentBundle: () => Promise.reject(new Error("演示模式不实际打印")),
    cancelPrintJob: () => Promise.reject(new Error("演示模式没有打印任务")),
    retryPrintJob: () => Promise.reject(new Error("演示模式没有打印任务")),
    printLogs: () => Promise.resolve(PrintLogList.parse({ logs: [] }).logs),
    printTemplates: () => Promise.resolve(PrintTemplateList.parse({ templates: [] })),
    publishPrintTemplate: () => Promise.reject(new Error("演示模式不发布模板")),
    publishPrintTemplateVersion: () => Promise.reject(new Error("演示模式不发布模板")),
    printDevices: () => Promise.resolve(PrintDevices.parse({ agents: [], printers: [] })),
    registerPrintAgent: () => Promise.reject(new Error("演示模式不注册代理")),
    disablePrintAgent: () => Promise.reject(new Error("演示模式不管理代理")),
    createShipment: () => Promise.reject(new Error("演示模式不创建发货单")),
    shipShipment: () => Promise.reject(new Error("演示模式不确认发货")),
    createBoxes: () => Promise.reject(new Error("演示模式不建箱")),
    pickScan: () => Promise.reject(new Error("演示模式不扫码")),
    verifyScan: () => Promise.reject(new Error("演示模式不扫码")),
    reprintBox: () => Promise.reject(new Error("演示模式不补打")),
    voidBox: () => Promise.reject(new Error("演示模式不作废箱")),
    resolveDiscrepancy: () => Promise.reject(new Error("演示模式不处理差异")),
    shipment: () =>
      Promise.resolve(
        ShipmentView.parse({
          id: SHIPMENT_ID,
          orderId: QUOTE_ID,
          orderNo: "WO-DEMO-001",
          customerId: CUSTOMER_ID,
          customerName: customer.name,
          status: "DRAFT",
          currency: "CNY",
          carrier: "顺丰",
          trackingNumber: null,
          address: "绍兴市柯桥区创意路 8 号",
          items: [],
          boxes: [],
          scans: [],
          totalQuantity: 0,
          boxQuantity: 0,
          printBlockedReason: "NO_BOXES",
          createdAt: NOW,
          shippedAt: null,
        }),
      ),
  };
}
