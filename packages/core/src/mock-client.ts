import {
  TenantSalesContact,
  ApprovalDetail,
  ApprovalDecisionResult,
  ApprovalQueue,
  AuthContextResponse,
  TenantChoicesResponse,
  CreatedQuoteShare,
  Customer360,
  CustomerListItem,
  CustomerTimelinePage,
  DemoSceneResponse,
  FieldOption,
  ItemQuoteListResponse,
  PrintCenterSnapshot,
  PrintDevices,
  PrintJobList,
  PrintLogList,
  PrintTemplateList,
  PanoramaSnapshot,
  QuoteDetail,
  QuoteConfirmation,
  QuoteListResponse,
  QuoteShareStats,
  QuoteShareStatsList,
  ReviseQuoteDraftResult,
  ShipmentView,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftResult,
  T006SuggestLinePriceResult,
  IntentView,
  isSampleStatusAvailable,
  parseWeightGsm,
  roleCapabilities,
} from "@weave-order/schema";
import type {
  ApprovalDecisionInput,
  IntentSource,
  JsonValue,
  OnboardingState,
  OnboardingStepKey,
  SampleStatus,
} from "@weave-order/schema";
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
const SAMPLE_ID_2 = "33333333-3333-4333-8333-333333333334";
const SAMPLE_ID_3 = "33333333-3333-4333-8333-333333333335";
const SAMPLE_ID_4 = "33333333-3333-4333-8333-333333333336";
const QUOTE_ID = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP_ID = "55555555-5555-4555-8555-555555555555";
const AUDIT_ID = "66666666-6666-4666-8666-666666666666";
const REVISION_ID = "77777777-7777-4777-8777-777777777777";
const SHIPMENT_ID = "88888888-8888-4888-8888-888888888888";
const ORDER_ID = "99999999-9999-4999-8999-999999999999";

const NOW = "2026-11-12T09:00:00.000Z";
const EXPIRES = "2026-11-26T09:00:00.000Z";

/** 演示模式的字典：与真实预置项同名同 code，便于本地点通治理交互。 */
function mockOption(
  fieldKey: FieldOption["fieldKey"],
  code: string,
  label: string,
  sortOrder: number,
): FieldOption {
  return {
    id: `mock-option-${code.toLowerCase()}`,
    tenantId: TENANT_ID,
    fieldKey,
    code,
    label,
    normalized: label.toLowerCase(),
    sortOrder,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const mockFieldOptions: FieldOption[] = [
  mockOption("customer.tier", "NEW", "新客", 10),
  mockOption("customer.tier", "REGULAR", "常规", 20),
  mockOption("customer.tier", "VIP", "VIP", 30),
  mockOption("customer.tier", "COLD", "沉睡", 40),
  mockOption("sample.category", "CAT-KNIT", "针织", 10),
  mockOption("sample.category", "CAT-WOVEN", "梭织", 20),
  mockOption("sample.category", "CAT-NONWOVEN", "无纺", 30),
  mockOption("sample.composition", "COMP-COTTON", "100% 棉", 10),
  mockOption("sample.composition", "COMP-POLYESTER", "100% 涤纶", 20),
  mockOption("sample.composition", "COMP-COTTON-POLY", "棉涤混纺", 30),
];

const customer = {
  id: CUSTOMER_ID,
  tenantId: TENANT_ID,
  code: "KH-018",
  name: "杭州青禾服饰",
  tier: "VIP" as const,
  status: "AVAILABLE" as const,
  contactName: "周敏",
  contactPhone: "138****6621",
  contactEmail: "zhoumin@example.com",
};

const contact = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenantId: TENANT_ID,
  customerId: CUSTOMER_ID,
  name: "周敏",
  role: "采购",
  phone: "138****6621",
  email: "zhoumin@example.com",
  wechat: "zhoumin_wechat",
  note: null,
  isPrimary: true,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const customerListItem = CustomerListItem.parse({
  ...customer,
  ownerId: MEMBERSHIP_ID,
  ownerName: "孙巨中",
  pendingQuoteCount: 1,
  pendingQuoteAmount: [{ amount: 760000, currency: "CNY" }],
  inTransitSampleCount: 2,
  activeOrderCount: 3,
  receivableBalance: [{ amount: 1280000, currency: "CNY" }],
  overdueReceivableCount: 1,
  lastContactAt: NOW,
  contactWechat: "zhoumin_wechat",
});

/**
 * 演示模式多给两位客户：列表排版与「待跟进优先」排序在本地就跑得出来。
 * 顺序即服务端 `sort=followup` 的结果：有未决/逾期的在前，再按最近往来倒序。
 */
const otherCustomerListItems = [
  CustomerListItem.parse({
    ...customer,
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    code: "KH-022",
    name: "绍兴华瑞制衣",
    tier: "REGULAR",
    contactName: "陈立",
    contactPhone: "139****2087",
    contactEmail: null,
    ownerId: MEMBERSHIP_ID,
    ownerName: "孙巨中",
    pendingQuoteCount: 2,
    pendingQuoteAmount: [{ amount: 2140000, currency: "CNY" }],
    inTransitSampleCount: 0,
    activeOrderCount: 1,
    receivableBalance: [],
    overdueReceivableCount: 0,
    lastContactAt: "2026-11-16T09:20:00.000Z",
    contactWechat: null,
  }),
  CustomerListItem.parse({
    ...customer,
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    code: "KH-031",
    name: "宁波恒达针织",
    tier: "NEW",
    contactName: "王倩",
    contactPhone: "137****4410",
    contactEmail: null,
    ownerId: null,
    ownerName: null,
    pendingQuoteCount: 0,
    pendingQuoteAmount: [],
    inTransitSampleCount: 1,
    activeOrderCount: 0,
    receivableBalance: [],
    overdueReceivableCount: 0,
    lastContactAt: "2026-10-28T02:10:00.000Z",
    contactWechat: "wangqian_nb",
  }),
];

const customer360 = Customer360.parse({
  customer,
  ownerId: MEMBERSHIP_ID,
  ownerName: "孙巨中",
  contacts: [contact],
  context: {
    customerId: CUSTOMER_ID,
    preferenceNotes: ["只做本白与浅色，不接受荧光增白。", "样布一次寄三色，附成分单。"],
    pricingBehavior: {
      sensitivity: "HIGH",
      counterofferAcceptanceRate: 0.62,
      typicalAcceptanceWindowDays: 3,
      notes: ["报价高于 15.5 元会先还价一轮。"],
    },
    paymentPattern: {
      preferredTerms: "TT_30D",
      onTimeRate: 0.86,
      averageDelayDays: 4,
      notes: [],
    },
    followupPreference: {
      preferredChannel: "WECHAT",
      preferredTimeWindow: "09:00-11:00",
      avoidDays: ["MONDAY"],
      notes: [],
    },
    decisionDeltas: [],
    updatedAt: NOW,
  },
  summary: {
    customerId: CUSTOMER_ID,
    pendingQuoteCount: 1,
    inTransitSampleCount: 2,
    activeOrderCount: 3,
    receivableBalance: [{ amount: 1280000, currency: "CNY" }],
    overdueReceivableCount: 1,
    latestShareableQuoteId: QUOTE_ID,
    lastContactAt: NOW,
  },
});

/** 演示客户 360：数字直接取列表行的聚合值，避免 mock 里再算第二套口径。 */
function buildMockCustomer360(item: CustomerListItem) {
  return {
    customer: {
      id: item.id,
      tenantId: item.tenantId,
      code: item.code,
      name: item.name,
      tier: item.tier,
      contactName: item.contactName,
      contactPhone: item.contactPhone,
      contactEmail: item.contactEmail,
    },
    ownerId: item.ownerId,
    ownerName: item.ownerName,
    contacts: [],
    context: {
      ...customer360.context,
      customerId: item.id,
      preferenceNotes: [],
      decisionDeltas: [],
    },
    summary: {
      customerId: item.id,
      pendingQuoteCount: item.pendingQuoteCount,
      inTransitSampleCount: item.inTransitSampleCount,
      activeOrderCount: item.activeOrderCount,
      receivableBalance: item.receivableBalance,
      overdueReceivableCount: item.overdueReceivableCount,
      latestShareableQuoteId: null,
      lastContactAt: item.lastContactAt,
    },
  };
}

const customerTimeline = CustomerTimelinePage.parse({
  events: [
    {
      id: `quote:${QUOTE_ID}`,
      kind: "quote",
      refId: QUOTE_ID,
      sourceId: QUOTE_ID,
      code: QUOTE_ID,
      status: "DRAFT",
      amount: { amount: 760000, currency: "CNY" },
      occurredAt: NOW,
    },
    {
      id: `sample_shipment:${SHIPMENT_ID}`,
      kind: "sample_shipment",
      refId: SHIPMENT_ID,
      sourceId: SHIPMENT_ID,
      code: SHIPMENT_ID,
      status: "CONFIRMED",
      amount: null,
      occurredAt: "2026-11-11T09:00:00.000Z",
    },
    {
      id: `order:${ORDER_ID}`,
      kind: "order",
      refId: ORDER_ID,
      sourceId: ORDER_ID,
      code: "SO-2611-018",
      status: "IN_PRODUCTION",
      amount: { amount: 1280000, currency: "CNY" },
      occurredAt: "2026-11-10T09:00:00.000Z",
    },
  ],
  hasMore: false,
  nextCursor: null,
});

const sample = {
  id: SAMPLE_ID,
  tenantId: TENANT_ID,
  code: "FM-220",
  name: "32S 精梳棉汗布 220g",
  composition: "100% 棉",
  category: "针织",
  color: "藏青",
  weight: "220g/m²",
  weightGsm: 220,
  unit: "meter" as const,
  costFloor: { amount: 1420, currency: "CNY" as const },
  status: "ACTIVE" as const,
  images: [],
  primaryImageUrl: null,
  createdAt: NOW,
};

const mockItemDetail = {
  item: {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    tenantId: TENANT_ID,
    status: "IN_PROGRESS" as const,
    customerId: CUSTOMER_ID,
    sampleId: SAMPLE_ID,
    quantityMilli: 150000,
    unit: "meter" as const,
    currentStage: "正在处理",
    nextAction: "确认最终价格",
    sourceIntentId: null,
    createdBy: MEMBERSHIP_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  customer: { id: CUSTOMER_ID, code: "KH-018", name: "杭州青禾服饰", status: "AVAILABLE" as const },
  sample: {
    id: SAMPLE_ID,
    code: "FM-220",
    name: "32S 精梳棉汗布 220g",
    status: "AVAILABLE" as const,
  },
  allowedTransitions: ["WAITING_INPUT", "WAITING_DECISION", "COMPLETED", "CLOSED"] as Array<
    "WAITING_INPUT" | "WAITING_DECISION" | "COMPLETED" | "CLOSED"
  >,
};

/**
 * 图墙的演示样本：至少 2 个成分、3 个克重档位，否则本地跑不出筛选效果。
 * 顺序就是真实服务端的「创建时间倒序」近似，供 mock 分页稳定取前 N 条。
 */
const mockSamples = [
  sample,
  {
    ...sample,
    id: SAMPLE_ID_2,
    code: "FM-320",
    name: "32S 棉毛布 320g",
    composition: "100% 棉",
    category: "毛圈",
    weight: "320g/m²",
    costFloor: { amount: 1860, currency: "CNY" as const },
  },
  {
    ...sample,
    id: SAMPLE_ID_3,
    code: "FM-180",
    name: "涤棉交织布 180g",
    composition: "65% 涤纶 35% 棉",
    category: "梭织",
    weight: "180g/m²",
    costFloor: { amount: 980, currency: "CNY" as const },
  },
  {
    ...sample,
    id: SAMPLE_ID_4,
    code: "FM-240",
    name: "粘胶弹力汗布 240g",
    composition: "95% 粘胶 5% 氨纶",
    category: "针织",
    weight: "240g/m²",
    costFloor: { amount: 1580, currency: "CNY" as const },
  },
];

/** 档位按出现次数倒序、同次数按字面升序，只统计当前状态且非空的值。
 * `ACTIVE` 与 `AVAILABLE` 是同一个「可用」语义（后者为 P0a 新值）。
 */
function mockWeightGsmRange(status: "ACTIVE" | "AVAILABLE" | "DRAFT" | "ARCHIVED" | "ALL") {
  const values = mockSamples
    .filter((item) => status === "ALL" || item.status === status)
    .map((item) => item.weightGsm)
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

function mockTiers(status: SampleStatus | "ALL", key: "composition" | "weight" | "color") {
  const counts = new Map<string, number>();
  for (const item of mockSamples) {
    if (
      status !== "ALL" &&
      item.status !== status &&
      !(isSampleStatusAvailable(item.status) && isSampleStatusAvailable(status))
    ) {
      continue;
    }
    const value = item[key];
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([value]) => value);
}

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
      capabilities: roleCapabilities({
        role: "OWNER",
        dataScope: "ALL",
        approvalLimitAmount: null,
      }),
    });

  // 演示意图：仍然遵守「未接入执行器 = 待受理」的真相，不制造假成功。
  const mockIntents: IntentView[] = [];
  const mockIntentsByRequest = new Map<string, IntentView>();
  let mockIntentSeq = 0;
  const submitMockIntent = (input: {
    text: string;
    source: IntentSource;
    clientRequestId: string;
    context?: JsonValue;
    attachmentIds?: string[];
  }) => {
    // 与真实服务端同样的幂等语义：同一次提交复用同一条意图。
    const existing = mockIntentsByRequest.get(input.clientRequestId);
    if (existing) {
      return Promise.resolve({
        intentId: existing.id,
        status: existing.status,
        executorState: existing.executorState,
        notice: existing.notice,
        intent: existing,
      });
    }
    mockIntentSeq += 1;
    const intent = IntentView.parse({
      id: `00000000-0000-4000-8000-${String(mockIntentSeq).padStart(12, "0")}`,
      tenantId: TENANT_ID,
      text: input.text.trim(),
      source: input.source,
      status: "QUEUED",
      statusLabel: "待受理",
      executorState: "NOT_CONNECTED",
      notice:
        "小织的整理服务还没接入。这句话已经记录下来了，但暂时不会被自动处理，也不会出现在审批里。",
      failureReason: null,
      draft: null,
      cancellableUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
    });
    mockIntents.unshift(intent);
    mockIntentsByRequest.set(input.clientRequestId, intent);
    return Promise.resolve({
      intentId: intent.id,
      status: intent.status,
      executorState: intent.executorState,
      notice: intent.notice,
      intent,
    });
  };

  // 演示进度：与真实服务端同样的合并规则（首次时间不覆盖、四步齐全才 allDoneAt）。
  let mockOnboarding: OnboardingState = {
    completedAt: {},
    collapsed: false,
    skipped: false,
    allDoneAt: null,
    updatedAt: null,
  };
  const updateMockOnboarding = (input: {
    collapsed?: boolean;
    skipped?: boolean;
    completeSteps?: OnboardingStepKey[];
  }) => {
    const now = new Date().toISOString();
    const completedAt = { ...mockOnboarding.completedAt };
    for (const step of input.completeSteps ?? []) {
      if (!completedAt[step]) completedAt[step] = now;
    }
    const allDone =
      mockOnboarding.allDoneAt !== null ||
      (["customer", "sample", "quote", "approve"] as const).every((step) => completedAt[step]);
    mockOnboarding = {
      completedAt,
      collapsed: input.collapsed ?? mockOnboarding.collapsed,
      skipped: input.skipped ?? mockOnboarding.skipped,
      allDoneAt: allDone ? (mockOnboarding.allDoneAt ?? now) : null,
      updatedAt: now,
    };
    return Promise.resolve(mockOnboarding);
  };

  return {
    previewOnboarding: () =>
      Promise.reject(new Error("演示模式不支持开通，请用真实账号打开开通链接")),
    claimOnboarding: () =>
      Promise.reject(new Error("演示模式不支持开通，请用真实账号打开开通链接")),
    startTenant: () => Promise.reject(new Error("演示模式不支持创建公司，请用真实账号")),
    previewInvite: () => Promise.reject(new Error("演示模式不支持邀请，请用真实账号")),
    acceptInvite: () => Promise.reject(new Error("演示模式不支持邀请，请用真实账号")),
    listTeam: () => Promise.resolve([]),
    updateTeamMember: () => Promise.reject(new Error("演示模式不支持调整成员权限，请用真实账号")),
    creditsUsage: () =>
      Promise.resolve({
        period: "2026-11",
        creditsIncluded: 20000,
        creditsUsed: 1200,
        percent: 6,
        state: "OK" as const,
      }),
    inviteMember: () => Promise.reject(new Error("演示模式不支持邀请，请用真实账号")),
    revokeInvite: () => Promise.reject(new Error("演示模式不支持撤销邀请，请用真实账号")),
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

    /** 演示模式没有后端 dev 路由：返回空目录，身份条据此不渲染。 */
    devPersonas: () => Promise.resolve([]),
    devSwitchPersona: () => Promise.reject(new Error("演示模式不支持切换身份，请用本地 dev 后端")),

    logout: () => Promise.resolve(),

    listCustomers: () => Promise.resolve([customer]),

    customerList: () => Promise.resolve([customerListItem, ...otherCustomerListItems]),

    customer360: (id) =>
      id === CUSTOMER_ID
        ? Promise.resolve(customer360)
        : (() => {
            const item = otherCustomerListItems.find((entry) => entry.id === id);
            if (!item) return Promise.reject(new Error("CUSTOMER_NOT_FOUND"));
            return Promise.resolve(Customer360.parse(buildMockCustomer360(item)));
          })(),

    customerContacts: () => Promise.resolve([contact]),

    createCustomerContact: (_customerId, input) =>
      Promise.resolve({
        contact: {
          ...contact,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          name: input.name,
          role: input.role ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          wechat: input.wechat ?? null,
          note: input.note ?? null,
          isPrimary: input.isPrimary ?? false,
        },
        warnings: [],
      }),

    updateCustomerContact: (_customerId, _contactId, input) =>
      Promise.resolve({
        contact: { ...contact, ...input },
        warnings: [],
      }),

    archiveCustomerContact: () =>
      Promise.resolve({ contact: { ...contact, isPrimary: false }, warnings: [] }),

    setPrimaryCustomerContact: () => Promise.resolve({ contact, warnings: [] }),

    contactRoles: () =>
      Promise.resolve({
        roles: [
          { code: "ROLE-PURCHASING", label: "采购" },
          { code: "ROLE-FINANCE", label: "财务" },
          { code: "ROLE-MERCHANDISER", label: "跟单" },
        ],
      }),

    exportContacts: () =>
      Promise.resolve({
        csv: "客户编号,客户名称,姓名\nKH-018,杭州青禾服饰,周敏",
        rowCount: 1,
        masked: false,
      }),

    createCustomer: (input) =>
      Promise.resolve({
        ...customer,
        code: input.code ?? "C000000-0001",
        name: input.name,
        tier: input.tier ?? "REGULAR",
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        contactEmail: input.contactEmail ?? null,
      }),

    createCustomerDraft: (input) =>
      Promise.resolve({
        customer: {
          ...customer,
          code: "C000000-0001",
          name: input.name ?? "待确认客户",
          status: "DRAFT" as const,
          contactName: input.contactName ?? null,
          contactPhone: input.contactPhone ?? null,
          contactEmail: input.contactEmail ?? null,
        },
        created: true,
        fields: [
          {
            fieldName: "name",
            value: input.name ?? null,
            status: "PENDING" as const,
            sourceKind: "bizcard" as const,
            sourceId: input.sourceId,
            updatedAt: NOW,
            candidates: [],
          },
          {
            fieldName: "contactPhone",
            value: input.contactPhone ?? null,
            status: "CONFLICT" as const,
            sourceKind: "bizcard" as const,
            sourceId: input.sourceId,
            updatedAt: NOW,
            candidates: [
              { value: "13800006621", sourceKind: "bizcard" as const, sourceId: input.sourceId },
              { value: "13800006622", sourceKind: "llm" as const, sourceId: null },
            ],
          },
        ],
      }),

    confirmCustomer: () => Promise.resolve({ ...customer, status: "AVAILABLE" as const }),

    previewCustomerMerge: (_sourceId, targetCustomerId) =>
      Promise.resolve({
        sourceCustomerId: CUSTOMER_ID,
        targetCustomerId,
        counts: {
          quotes: 2,
          orders: 1,
          sampleShipments: 1,
          receivables: 0,
          items: 1,
          contacts: 1,
          decisionDeltas: 0,
        },
        contactConflicts: [],
        previewToken: "mock-preview-token",
        expiresAt: NOW,
      }),

    mergeCustomer: (_sourceId, input) =>
      Promise.resolve({
        customer: { ...customer, id: input.targetCustomerId },
        moved: {
          quotes: 2,
          orders: 1,
          sampleShipments: 1,
          receivables: 0,
          items: 1,
          contacts: 1,
          decisionDeltas: 0,
        },
        skippedContactCount: 0,
        undoUntil: NOW,
        undoToken: "mock-undo-token",
      }),

    undoCustomerMerge: () =>
      Promise.resolve({
        customer,
        reverted: {
          quotes: 2,
          orders: 1,
          sampleShipments: 1,
          receivables: 0,
          items: 1,
          contacts: 1,
          decisionDeltas: 0,
        },
      }),

    customerFields: () =>
      Promise.resolve({
        resourceType: "customer" as const,
        resourceId: CUSTOMER_ID,
        resourceStatus: "AVAILABLE" as const,
        fields: [
          {
            fieldName: "name",
            value: customer.name,
            status: "CONFIRMED" as const,
            sourceKind: "bizcard" as const,
            sourceId: null,
            updatedAt: NOW,
            candidates: [],
          },
          {
            fieldName: "contactPhone",
            value: null,
            status: "CONFLICT" as const,
            sourceKind: "bizcard" as const,
            sourceId: null,
            updatedAt: NOW,
            candidates: [
              { value: "13800006621", sourceKind: "bizcard" as const, sourceId: null },
              { value: "13800006622", sourceKind: "llm" as const, sourceId: null },
            ],
          },
        ],
        pendingCount: 1,
      }),

    updateCustomerFields: (_customerId, input) =>
      Promise.resolve({
        resourceType: "customer" as const,
        resourceId: CUSTOMER_ID,
        resourceStatus: "AVAILABLE" as const,
        fields: input.fields.map((field) => ({
          fieldName: field.fieldName,
          value: field.value,
          status: "CONFIRMED" as const,
          sourceKind: "manual" as const,
          sourceId: null,
          updatedAt: NOW,
          candidates: [],
        })),
        pendingCount: 0,
      }),

    importBatch: (batch) => {
      const customers = batch.customers ?? [];
      const samples = batch.samples ?? [];
      const totalRows = customers.length + samples.length;
      const keyOf = (row: unknown, index: number) => {
        const code =
          typeof row === "object" && row !== null && "code" in row
            ? (row as { code?: unknown }).code
            : undefined;
        // 只接受字符串/数字，避免把对象 stringify 成 "[object Object]"。
        return typeof code === "string" || typeof code === "number" ? String(code) : `#${index}`;
      };
      return Promise.resolve({
        committed: true,
        batchError: null,
        totalRows,
        okRows: totalRows,
        rejectedRows: 0,
        importedCustomers: customers.length,
        importedSamples: samples.length,
        correlationId: null,
        // 回执的 row 是「该实体数组内的 0-based 下标」，客户与样品各自从 0 起。
        rows: [
          ...customers.map((row, index) => ({
            ok: true as const,
            kind: "customer" as const,
            row: index,
            key: keyOf(row, index),
          })),
          ...samples.map((row, index) => ({
            ok: true as const,
            kind: "fabric_sample" as const,
            row: index,
            key: keyOf(row, index),
          })),
        ],
      });
    },

    customerTimeline: () => Promise.resolve(customerTimeline),

    listFieldOptions: (field) =>
      Promise.resolve(
        mockFieldOptions
          .filter((option) => option.fieldKey === field)
          .map((option) => ({
            ...option,
            usage: 0,
          })),
      ),

    resolveFieldValue: (field, value) => {
      const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
      const hit = mockFieldOptions.find(
        (option) =>
          option.fieldKey === field &&
          (option.normalized === normalized || option.code.toLowerCase() === normalized),
      );
      return Promise.resolve({
        fieldKey: field,
        input: value,
        normalized,
        matched: hit !== undefined,
        code: hit?.code ?? null,
        label: hit?.label ?? null,
      });
    },

    createFieldOption: (field, label) =>
      Promise.resolve({
        ...(mockFieldOptions.find((option) => option.fieldKey === field) ?? mockFieldOptions[0]!),
        id: `mock-option-${Math.random().toString(36).slice(2, 8)}`,
        fieldKey: field,
        code: `T-MOCK-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        label,
        normalized: label.toLowerCase(),
        active: true,
        usage: 0,
      }),

    renameFieldOption: (id, label) =>
      Promise.resolve({
        ...(mockFieldOptions.find((option) => option.id === id) ?? mockFieldOptions[0]!),
        id,
        label,
        normalized: label.toLowerCase(),
        usage: 0,
      }),

    deleteFieldOption: () => Promise.resolve(),

    restoreFieldOption: (id) =>
      Promise.resolve({
        ...(mockFieldOptions.find((option) => option.id === id) ?? mockFieldOptions[0]!),
        id,
        active: true,
        usage: 0,
      }),

    reorderFieldOptions: (field, ids) =>
      Promise.resolve(
        ids.map((id, index) => ({
          ...(mockFieldOptions.find((option) => option.id === id) ?? mockFieldOptions[0]!),
          id,
          fieldKey: field,
          sortOrder: (index + 1) * 10,
          usage: 0,
        })),
      ),

    previewFieldOptionMerge: (sourceId, targetId) =>
      Promise.resolve({
        fieldKey: "customer.tier",
        source: mockFieldOptions.find((option) => option.id === sourceId) ?? mockFieldOptions[0]!,
        target: mockFieldOptions.find((option) => option.id === targetId) ?? mockFieldOptions[1]!,
        affected: 0,
        samples: [],
      }),

    mergeFieldOptions: () => Promise.resolve({ affected: 0 }),

    listSamples: (limit = 50) => Promise.resolve(mockSamples.slice(0, limit)),

    listSamplesPage: (params = {}) => {
      const status = params.status ?? "ACTIVE";
      const query = params.query?.trim().toLowerCase() ?? "";
      const composition = params.composition?.trim().toLowerCase() ?? "";
      let samples = mockSamples.filter(
        (item) =>
          (status === "ALL" || item.status === status) &&
          (!params.category || item.category === params.category) &&
          (!query ||
            item.code.toLowerCase().includes(query) ||
            item.name.toLowerCase().includes(query) ||
            (item.composition ?? "").toLowerCase().includes(query)) &&
          (!composition || (item.composition ?? "").toLowerCase().includes(composition)) &&
          (!params.weights ||
            params.weights.length === 0 ||
            params.weights.includes(item.weight)) &&
          (!params.colors ||
            params.colors.length === 0 ||
            params.colors.includes(item.color ?? null)) &&
          (params.weightGsmMin == null || (item.weightGsm ?? 0) >= params.weightGsmMin) &&
          (params.weightGsmMax == null || (item.weightGsm ?? 0) <= params.weightGsmMax),
      );
      const limit = params.limit ?? 24;
      const total = samples.length;
      samples = samples.slice(0, limit);
      return Promise.resolve({
        samples,
        nextCursor: null,
        hasMore: total > samples.length,
        total,
        remaining: Math.max(0, total - samples.length),
        categories: [
          ...new Set(
            mockSamples
              .filter((item) => status === "ALL" || item.status === status)
              .map((item) => item.category)
              .filter((value): value is string => Boolean(value)),
          ),
        ].sort(),
        compositions: mockTiers(status, "composition"),
        weights: mockTiers(status, "weight"),
        colors: mockTiers(status, "color"),
        weightGsmRange: mockWeightGsmRange(status),
      });
    },

    getSample: () => Promise.resolve(sample),

    createSample: (input) =>
      Promise.resolve({
        ...sample,
        id: SAMPLE_ID,
        code: input.code,
        name: input.name,
        composition: input.composition ?? null,
        color: input.color ?? null,
        weight: input.weight ?? null,
        weightGsm: parseWeightGsm(input.weight),
      }),

    createSampleDraft: (input) =>
      Promise.resolve({
        sample: {
          ...sample,
          code: "S000000-0001",
          name: input.name ?? "待确认样品",
          composition: input.composition ?? null,
          weight: input.weight ?? null,
          status: "DRAFT" as const,
        },
        created: true,
        fields: [
          {
            fieldName: "name",
            value: input.name ?? null,
            status: "PENDING" as const,
            sourceKind: "label" as const,
            sourceId: input.sourceId,
            updatedAt: NOW,
            candidates: [],
          },
        ],
      }),

    confirmSample: () => Promise.resolve({ ...sample, status: "AVAILABLE" as const }),

    sampleFields: () =>
      Promise.resolve({
        resourceType: "sample" as const,
        resourceId: SAMPLE_ID,
        resourceStatus: "AVAILABLE" as const,
        fields: [
          {
            fieldName: "composition",
            value: sample.composition,
            status: "CONFIRMED" as const,
            sourceKind: "label" as const,
            sourceId: null,
            updatedAt: NOW,
            candidates: [],
          },
        ],
        pendingCount: 0,
      }),

    updateSampleFields: (_sampleId, input) =>
      Promise.resolve({
        resourceType: "sample" as const,
        resourceId: SAMPLE_ID,
        resourceStatus: "AVAILABLE" as const,
        fields: input.fields.map((field) => ({
          fieldName: field.fieldName,
          value: field.value,
          status: "CONFIRMED" as const,
          sourceKind: "manual" as const,
          sourceId: null,
          updatedAt: NOW,
          candidates: [],
        })),
        pendingCount: 0,
      }),

    updateSample: (_id, input) =>
      Promise.resolve({
        ...sample,
        // 演示模式下 PATCH 也要回传改后的标识，否则编辑 toast 只能验证到旧编码。
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.composition !== undefined ? { composition: input.composition } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      }),

    archiveSample: () => Promise.resolve({ ...sample, status: "ARCHIVED" as const }),

    retrySampleImage: () => Promise.resolve(sample),

    presignImage: () => Promise.reject(new Error("演示模式不支持上传图片，请用真实账号")),

    confirmImage: () => Promise.reject(new Error("演示模式不支持上传图片，请用真实账号")),

    ingestInboundReply: () => Promise.reject(new Error("演示模式不支持录入客户回复，请用真实账号")),

    inboundReplies: () => Promise.resolve([]),

    submitIntent: submitMockIntent,

    submitInbound: () => Promise.reject(new Error("演示模式不支持统一输入，请用真实账号")),

    inbound: () => Promise.reject(new Error("演示模式不支持统一输入，请用真实账号")),

    startInbound: () => Promise.reject(new Error("演示模式不支持统一输入，请用真实账号")),

    reviseInbound: () => Promise.reject(new Error("演示模式不支持统一输入，请用真实账号")),

    intents: () => Promise.resolve([...mockIntents]),

    intent: (id: string) => {
      const found = mockIntents.find((item) => item.id === id);
      return found ? Promise.resolve(found) : Promise.reject(new Error("演示模式里没有这条意图"));
    },

    cancelIntent: (id: string) => {
      const index = mockIntents.findIndex((item) => item.id === id);
      const found = mockIntents[index];
      if (!found) return Promise.reject(new Error("演示模式里没有这条意图"));
      const cancelled = IntentView.parse({
        ...found,
        status: "CANCELLED",
        statusLabel: "已撤销",
        cancellableUntil: null,
        cancelledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockIntents[index] = cancelled;
      return Promise.resolve(cancelled);
    },

    onboardingState: () => Promise.resolve(mockOnboarding),

    updateOnboardingState: updateMockOnboarding,

    panorama: () =>
      Promise.resolve(
        PanoramaSnapshot.parse({
          generatedAt: NOW,
          customers: [customer],
          samples: [sample],
          items: [current.item],
          audit: [auditEntry],
          events: [
            {
              id: AUDIT_ID,
              eventKind: "AGENT_DONE",
              actorType: "AGENT",
              actorLabel: "小织",
              action: "QUOTE_DRAFT_GENERATED",
              summary: "生成了报价草稿",
              entityType: "quote",
              entityId: QUOTE_ID,
              createdAt: NOW,
            },
            {
              id: REVISION_ID,
              eventKind: "HUMAN_DONE",
              actorType: "HUMAN",
              actorLabel: "你",
              action: "REVISION_REQUESTED",
              summary: "发起了改稿",
              entityType: "quote",
              entityId: QUOTE_ID,
              createdAt: "2026-11-12T09:05:00.000Z",
            },
          ],
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
            todayAgentDoneCount: 1,
          },
        }),
      ),

    approvals: () =>
      Promise.resolve(ApprovalQueue.parse({ items: current.item.pending ? [current.item] : [] })),

    demoScenes: () =>
      Promise.resolve([
        DemoSceneResponse.parse({
          scene: {
            key: "approval-pending",
            title: "有一张报价草稿等你拍板",
            description: "演示模式：这张草稿来自本地 mock。",
            href: "/today?scene=approval-pending",
            anchor: { kind: "quote", customerCode: "KH-018" },
            highlight: "approval",
            entityId: null,
            resolved: false,
          },
        }).scene,
      ]),

    demoScene: (key) => {
      if (key !== "approval-pending") return Promise.reject(new Error("NOT_FOUND"));
      return Promise.resolve(
        DemoSceneResponse.parse({
          scene: {
            key,
            title: "有一张报价草稿等你拍板",
            description: "演示模式：这张草稿来自本地 mock。",
            href: "/today?scene=approval-pending",
            anchor: { kind: "quote", customerCode: "KH-018" },
            highlight: "approval",
            entityId: null,
            resolved: false,
          },
        }).scene,
      );
    },

    approvalDetail: (id) => {
      if (id !== QUOTE_ID) {
        return Promise.reject(new Error("NOT_FOUND"));
      }
      return Promise.resolve(current);
    },

    audit: () => Promise.resolve(audit),

    auditLog: () => {
      const items = audit.map((entry) => ({
        seq: entry.seq,
        createdAt: entry.createdAt,
        actorType: entry.actorType,
        actorId: entry.actorId,
        actorName: null,
        actorRole: null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        entityLabel: null,
        highRisk: false,
        summary: `${entry.action} · ${entry.entityType}`,
      }));
      return Promise.resolve({ scope: "ALL" as const, items, nextCursor: null });
    },
    auditLogDetail: (seq) => {
      const entry = audit.find((item) => item.seq === seq) ?? audit[0]!;
      return Promise.resolve({
        seq: entry.seq,
        createdAt: entry.createdAt,
        actorType: entry.actorType,
        actorId: entry.actorId,
        actorName: null,
        actorRole: null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        entityLabel: null,
        highRisk: false,
        summary: `${entry.action} · ${entry.entityType}`,
        before: entry.before,
        after: entry.after,
        maskedFields: [],
        correlationId: entry.correlationId,
      });
    },
    auditLogSummary: (range) =>
      Promise.resolve({
        scope: "ALL" as const,
        range: range as "30d",
        total: audit.length,
        highRiskCount: 0,
        days: [{ date: NOW.slice(0, 10), count: audit.length }],
        actorTypes: [{ actorType: "AGENT" as const, count: audit.length }],
      }),
    createAuditExport: () => Promise.reject(new Error("演示模式不支持导出操作日志，请用真实账号")),
    auditExportJob: () => Promise.reject(new Error("演示模式不支持导出操作日志，请用真实账号")),

    searchBySpec: () =>
      Promise.resolve(
        T002SearchFabricBySpecResult.parse({
          ok: true,
          data: { matches: [{ sample, score: 1, matchedOn: ["name"] }] },
        }),
      ),

    searchByImageUrl: () =>
      Promise.resolve({
        ok: true,
        data: { embeddingModel: "mock", dimension: 16, matches: [{ sample, score: 1 }] },
      }),

    createSampleShipment: () => Promise.reject(new Error("演示模式不支持建寄样单，请用真实账号")),

    generateQuoteDraft: (_input: Parameters<ApiClient["generateQuoteDraft"]>[0]) =>
      Promise.resolve(T004GenerateQuoteDraftResult.parse({ ok: true, data: { draft } })),

    quotes: () =>
      Promise.resolve(
        QuoteListResponse.parse({
          items: [
            {
              id: QUOTE_ID,
              customerId: draft.customerId,
              customerName: customer.name,
              status: "DRAFT",
              currency: draft.currency,
              total: draft.total,
              version: 1,
              itemCount: draft.items.length,
              expiresAt: draft.expiresAt,
              createdAt: draft.createdAt,
              updatedAt: draft.createdAt,
              pendingApproval: true,
            },
          ],
          nextCursor: null,
        }),
      ),

    quote: (id) => {
      if (id !== QUOTE_ID) return Promise.reject(new Error("NOT_FOUND"));
      return Promise.resolve(QuoteDetail.parse({ draft, version: 1, status: "DRAFT" }));
    },

    suggestLinePrice: (input) =>
      Promise.resolve(
        T006SuggestLinePriceResult.parse({
          ok: true,
          data: {
            pricing: {
              customerId: input.customerId,
              fabricSampleId: input.fabricSampleId,
              currency: input.currency,
              quantity: input.quantity,
              costFloor: null,
              markupRateBps: 0,
              suggestedUnitPrice: draft.items[0]?.unitPrice ?? {
                amount: 0,
                currency: input.currency,
              },
              components: [
                {
                  kind: "POLICY",
                  label: "演示建议价",
                  amount: draft.items[0]?.unitPrice ?? { amount: 0, currency: input.currency },
                  rateBps: null,
                  source: "demo",
                  note: null,
                },
              ],
              computedBy: "KERNEL",
            },
          },
        }),
      ),

    reviseQuote: () =>
      Promise.resolve(
        ReviseQuoteDraftResult.parse({
          ok: false,
          error: { code: "INVALID_INPUT", message: "演示模式不支持改价，请用真实账号" },
        }),
      ),

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
    orders: () => Promise.resolve({ orders: [], total: 0, hasMore: false, nextCursor: null }),

    orderFunnel: () =>
      Promise.resolve({
        stages: [
          { key: "DRAFT" as const, label: "报价草稿", statuses: ["DRAFT" as const], count: 0 },
          {
            key: "CONFIRMED" as const,
            label: "已成交",
            statuses: ["CONFIRMED" as const],
            count: 0,
          },
          {
            key: "IN_PRODUCTION" as const,
            label: "生产中",
            statuses: ["IN_PRODUCTION" as const],
            count: 0,
          },
          {
            key: "SHIPPED" as const,
            label: "已发货",
            statuses: ["SHIPPED" as const, "COMPLETED" as const],
            count: 0,
          },
        ],
        generatedAt: NOW,
      }),

    orderWorkbench: () => Promise.reject(new Error("演示模式没有订单详情")),

    receivables: () =>
      Promise.resolve({
        receivables: [],
        hasMore: false,
        nextCursor: null,
        summary: { overdue: 0, dueSoon: 0, settled: 0, balanceByCurrency: [] },
      }),

    recordPayment: () => Promise.reject(new Error("演示模式不记账")),

    statement: () => Promise.reject(new Error("演示模式没有对账单")),

    presignReceipt: () => Promise.reject(new Error("演示模式不上传凭证")),

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
    printJob: () => Promise.reject(new Error("演示模式没有打印任务")),
    previewSampleCard: () => Promise.reject(new Error("演示模式不预览样卡")),
    salesContact: () =>
      Promise.resolve(TenantSalesContact.parse({ name: "李娜", phone: "13800136621" })),
    updateSalesContact: () => Promise.reject(new Error("演示模式不改业务员联系方式")),
    printSampleCards: () => Promise.reject(new Error("演示模式不实际打印")),
    sampleCardJobs: () => Promise.resolve([]),
    reprintSampleCard: () => Promise.reject(new Error("演示模式不补打样卡")),
    printLogs: () => Promise.resolve(PrintLogList.parse({ logs: [] }).logs),
    printTemplates: () => Promise.resolve(PrintTemplateList.parse({ templates: [] })),
    printTemplate: () => Promise.reject(new Error("演示模式没有模板")),
    copyPrintTemplate: () => Promise.reject(new Error("演示模式不复制模板")),
    savePrintTemplateDraft: () => Promise.reject(new Error("演示模式不保存模板")),
    activatePrintTemplateVersion: () => Promise.reject(new Error("演示模式不回滚模板")),
    previewTemplateSampleCard: () => Promise.reject(new Error("演示模式不预览模板")),
    testPrintTemplate: () => Promise.reject(new Error("演示模式不试打模板")),
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
    listItems: () =>
      Promise.resolve({
        items: [mockItemDetail],
        nextCursor: null,
        hasMore: false,
      }),
    getItem: () => Promise.resolve(mockItemDetail),
    createItem: (input) => {
      const missing = [
        ...(input.customerId ? [] : ["customerId" as const]),
        ...(input.sampleId ? [] : ["sampleId" as const]),
        ...(input.quantity ? [] : ["quantity" as const]),
      ];
      if (missing.length > 0) {
        return Promise.resolve({
          outcome: "NEEDS_INPUT" as const,
          item: null,
          missingFields: missing,
          message: "还缺客户、样品或数量，补齐后再建事项",
        });
      }
      return Promise.resolve({
        outcome: "CREATED" as const,
        item: mockItemDetail.item,
        missingFields: [],
        message: "事项已创建",
      });
    },
    transitionItem: (_itemId, input) =>
      Promise.resolve({
        ...mockItemDetail,
        item: { ...mockItemDetail.item, status: input.status },
        allowedTransitions:
          input.status === "COMPLETED" || input.status === "CLOSED"
            ? []
            : mockItemDetail.allowedTransitions,
      }),
    completeItem: () =>
      Promise.resolve({
        ...mockItemDetail,
        item: {
          ...mockItemDetail.item,
          status: "COMPLETED" as const,
          currentStage: "已完成",
          nextAction: "查看结果",
        },
        allowedTransitions: [],
      }),
    listItemQuotes: () =>
      Promise.resolve(
        ItemQuoteListResponse.parse({
          quotes: [
            {
              id: QUOTE_ID,
              itemId: mockItemDetail.item.id,
              quoteNumber: `BJ-20261112-${QUOTE_ID.slice(0, 4).toUpperCase()}`,
              status: "DRAFT",
              currency: draft.currency,
              total: draft.total,
              version: 1,
              expiresAt: draft.expiresAt,
              createdAt: draft.createdAt,
              confirmedBy: null,
              confirmedAt: null,
            },
          ],
        }),
      ),
    createItemQuote: () => Promise.reject(new Error("演示模式不发起新报价")),
    quoteBasis: () => Promise.reject(new Error("演示模式没有报价依据")),
    reviseItemQuote: () => Promise.reject(new Error("演示模式不改价")),
    confirmQuote: () =>
      Promise.resolve(
        QuoteConfirmation.parse({
          quoteId: QUOTE_ID,
          status: "SENT",
          confirmedBy: "demo-owner",
          confirmedAt: NOW,
        }),
      ),
    quoteCopyText: () => Promise.reject(new Error("演示模式不生成报价文本")),
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
