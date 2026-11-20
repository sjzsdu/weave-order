import type {
  ApprovalItem,
  AuditLogEntry,
  Customer,
  FabricSample,
  QuoteLineItem,
  QuoteStatus,
} from "@weave-order/schema";
import type { QuoteRecord } from "./types";

/**
 * 演示数据：只用于 `TARO_APP_MOCK=1` 的本地联调 / 离线演练。
 * 所有金额为整数分；客户/样品字段严格满足 T0 契约。
 */

export const MOCK_TENANT_ID = "00000000-0000-4000-8000-000000000001";

export const MOCK_CUSTOMERS: Customer[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: MOCK_TENANT_ID,
    code: "C-1001",
    name: "青禾服饰",
    tier: "VIP",
    status: "AVAILABLE",
    contactName: "陈青",
    contactPhone: "13800138001",
    contactEmail: "chen@qinghe.example.com",
  },
  {
    id: "11111111-1111-4111-8111-222222222222",
    tenantId: MOCK_TENANT_ID,
    code: "C-1002",
    name: "华瑞制衣",
    tier: "REGULAR",
    status: "AVAILABLE",
    contactName: "王瑞",
    contactPhone: "13900139002",
    contactEmail: "wang@huarui.example.com",
  },
  {
    id: "11111111-1111-4111-8111-333333333333",
    tenantId: MOCK_TENANT_ID,
    code: "C-1003",
    name: "锦程纺织",
    tier: "NEW",
    status: "AVAILABLE",
    contactName: "李锦",
    contactPhone: "13700137003",
    contactEmail: null,
  },
];

export const MOCK_SAMPLES: FabricSample[] = [
  {
    id: "22222222-2222-4222-8222-111111111111",
    tenantId: MOCK_TENANT_ID,
    code: "S-2201",
    name: "32S 精梳棉 220g",
    composition: "100% 棉",
    weight: "220g",
    unit: "meter",
    costFloor: { amount: 1180, currency: "CNY" },
    status: "ACTIVE",
    primaryImageUrl: null,
    createdAt: "2026-10-02T03:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId: MOCK_TENANT_ID,
    code: "S-2210",
    name: "40S 涤棉 180g",
    composition: "65% 涤纶 35% 棉",
    weight: "180g",
    unit: "meter",
    costFloor: { amount: 920, currency: "CNY" },
    status: "ACTIVE",
    primaryImageUrl: null,
    createdAt: "2026-10-03T03:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-333333333333",
    tenantId: MOCK_TENANT_ID,
    code: "S-2301",
    name: "亚麻 180g",
    composition: "55% 亚麻 45% 棉",
    weight: "180g",
    unit: "meter",
    costFloor: { amount: 1560, currency: "CNY" },
    status: "ACTIVE",
    primaryImageUrl: null,
    createdAt: "2026-10-04T03:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-444444444444",
    tenantId: MOCK_TENANT_ID,
    code: "S-2401",
    name: "21S 普梳棉 260g",
    composition: "100% 棉",
    weight: "260g",
    unit: "meter",
    costFloor: { amount: 1050, currency: "CNY" },
    status: "ACTIVE",
    primaryImageUrl: null,
    createdAt: "2026-10-05T03:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-555555555555",
    tenantId: MOCK_TENANT_ID,
    code: "S-2501",
    name: "天丝 190g",
    composition: "100% 天丝",
    weight: "190g",
    unit: "meter",
    costFloor: { amount: 1720, currency: "CNY" },
    status: "ACTIVE",
    primaryImageUrl: null,
    createdAt: "2026-10-06T03:00:00.000Z",
  },
];

function line(
  sampleId: string,
  description: string,
  quantity: number,
  unitPriceCents: number,
): QuoteLineItem {
  return {
    fabricSampleId: sampleId,
    description,
    quantity: { value: quantity, unit: "meter" },
    unitPrice: { amount: unitPriceCents, currency: "CNY" },
    lineTotal: { amount: unitPriceCents * quantity, currency: "CNY" },
  };
}

const initialItems = [line("22222222-2222-4222-8222-111111111111", "32S 精梳棉 220g", 500, 1520)];

export function initialQuotes(now: Date = new Date()): QuoteRecord[] {
  const createdAt = new Date(now.getTime() - 42 * 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 14 * 24 * 3600_000).toISOString();
  // 另外两位客户各有一张报价：列表的「待跟进优先」在演示模式下也有真实顺序可看。
  const otherQuotesCreated = (hoursAgo: number) =>
    new Date(now.getTime() - hoursAgo * 3600_000).toISOString();
  return [
    {
      id: "33333333-3333-4333-8333-111111111111",
      tenantId: MOCK_TENANT_ID,
      customerId: "11111111-1111-4111-8111-111111111111",
      status: "DRAFT" satisfies QuoteStatus,
      currency: "CNY",
      items: initialItems,
      subtotal: { amount: 760000, currency: "CNY" },
      total: { amount: 760000, currency: "CNY" },
      amountsComputedByKernel: true,
      validityDays: 14,
      expiresAt,
      createdAt,
      remarks: "客户微信原话：这款 220g 棉的，要 500 米。",
      version: 1,
    },
    {
      id: "33333333-3333-4333-8333-222222222222",
      tenantId: MOCK_TENANT_ID,
      customerId: "11111111-1111-4111-8111-222222222222",
      status: "SENT" satisfies QuoteStatus,
      currency: "CNY",
      items: initialItems,
      subtotal: { amount: 1280000, currency: "CNY" },
      total: { amount: 1280000, currency: "CNY" },
      amountsComputedByKernel: true,
      validityDays: 14,
      expiresAt,
      createdAt: otherQuotesCreated(50),
      remarks: null,
      version: 1,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      tenantId: MOCK_TENANT_ID,
      customerId: "11111111-1111-4111-8111-333333333333",
      status: "DRAFT" satisfies QuoteStatus,
      currency: "CNY",
      items: initialItems,
      subtotal: { amount: 560000, currency: "CNY" },
      total: { amount: 560000, currency: "CNY" },
      amountsComputedByKernel: true,
      validityDays: 14,
      expiresAt,
      createdAt: otherQuotesCreated(6),
      remarks: "客户问：能不能先寄三色样？",
      version: 1,
    },
  ];
}

export function initialAudit(now: Date = new Date()): AuditLogEntry[] {
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  return [
    {
      id: "77777777-7777-4777-8777-111111111111",
      tenantId: MOCK_TENANT_ID,
      seq: 3,
      action: "QUOTE_DRAFT_GENERATED",
      entityType: "quote",
      entityId: "33333333-3333-4333-8333-111111111111",
      actorType: "AGENT",
      actorId: "小织",
      before: null,
      after: { status: "DRAFT", total: 760000, basis: "历史价 15.00/15.40 · 现货 1,200 米" },
      correlationId: null,
      createdAt: minutesAgo(42),
    },
    {
      id: "77777777-7777-4777-8777-222222222222",
      tenantId: MOCK_TENANT_ID,
      seq: 2,
      action: "SAMPLE_SHIPMENT_DRAFTED",
      entityType: "sample_shipment",
      entityId: "44444444-4444-4444-8444-111111111111",
      actorType: "AGENT",
      actorId: "小跟",
      before: null,
      after: { customer: "华瑞制衣", reason: "寄样签收 3 天未回复" },
      correlationId: null,
      createdAt: minutesAgo(180),
    },
    {
      id: "77777777-7777-4777-8777-333333333333",
      tenantId: MOCK_TENANT_ID,
      seq: 1,
      action: "CUSTOMER_CONTEXT_UPDATED",
      entityType: "customer",
      entityId: "11111111-1111-4111-8111-111111111111",
      actorType: "AGENT",
      actorId: "小织",
      before: null,
      after: { preference: "偏好 220g 精梳棉，价格敏感度中" },
      correlationId: null,
      createdAt: minutesAgo(240),
    },
  ];
}

export function initialApprovals(quotes: QuoteRecord[], now: Date = new Date()): ApprovalItem[] {
  const draft = quotes.find((quote) => quote.status === "DRAFT");
  const items: ApprovalItem[] = [];
  if (draft) {
    items.push({
      id: draft.id,
      kind: "quote",
      title: `报价 · 青禾服饰`,
      summary: "500 米 × 15.20 元/米 · 有效期 14 天 · 依据：历史价 15.00/15.40、现货 1,200 米",
      status: draft.status,
      pending: true,
      amountCents: draft.total.amount,
      currency: draft.currency,
      customerId: draft.customerId,
      createdAt: draft.createdAt,
      confirmedBy: null,
    });
  }
  items.push({
    id: "44444444-4444-4444-8444-111111111111",
    kind: "sample_shipment",
    title: "寄样 · 华瑞制衣",
    summary: "3 块色卡 · 顺丰 · 依据：客户询价 180g 涤棉",
    status: "DRAFT",
    pending: true,
    amountCents: null,
    currency: null,
    customerId: "11111111-1111-4111-8111-222222222222",
    createdAt: new Date(now.getTime() - 25 * 60_000).toISOString(),
    confirmedBy: null,
  });
  return items;
}
