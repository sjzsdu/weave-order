import type { Customer, CustomerContext, QuoteDraft, QuoteSummary } from "../src";

export const UUID_A = "123e4567-e89b-12d3-a456-426614174000";
export const UUID_B = "123e4567-e89b-12d3-a456-426614174001";
export const UUID_C = "123e4567-e89b-12d3-a456-426614174002";
export const NOW = "2026-11-11T11:00:00.000Z";

export function makeMoney(amount = 1000, currency: "CNY" | "USD" | "EUR" | "HKD" = "CNY") {
  return { amount, currency };
}

export function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: UUID_A,
    tenantId: UUID_A,
    code: "C001",
    name: "杭州织造有限公司",
    tier: "VIP",
    status: "AVAILABLE",
    contactName: "张三",
    contactPhone: "13800000000",
    contactEmail: "zhangsan@example.com",
    ...overrides,
  };
}

export function makeCustomerContext(overrides: Partial<CustomerContext> = {}): CustomerContext {
  return {
    customerId: UUID_A,
    preferenceNotes: ["偏好高支棉"],
    pricingBehavior: {
      sensitivity: "MEDIUM",
      counterofferAcceptanceRate: 0.6,
      typicalAcceptanceWindowDays: 7,
      notes: [],
    },
    paymentPattern: {
      preferredTerms: "TT_30D",
      onTimeRate: 0.95,
      averageDelayDays: 2,
      notes: [],
    },
    followupPreference: {
      preferredChannel: "WECHAT",
      preferredTimeWindow: "09:00-11:00",
      avoidDays: ["SATURDAY", "SUNDAY"],
      notes: [],
    },
    decisionDeltas: [
      {
        id: UUID_B,
        field: "unitPrice",
        originalValue: 1000,
        modifiedValue: 950,
        scenarioTag: "PRICING",
        actor: "HUMAN",
        changedAt: NOW,
      },
    ],
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeQuoteSummary(overrides: Partial<QuoteSummary> = {}): QuoteSummary {
  return {
    id: UUID_B,
    status: "ACCEPTED",
    currency: "CNY",
    total: makeMoney(100000),
    createdAt: NOW,
    ...overrides,
  };
}

export function makeQuoteDraft(overrides: Partial<QuoteDraft> = {}): QuoteDraft {
  return {
    id: UUID_B,
    tenantId: UUID_A,
    customerId: UUID_A,
    status: "DRAFT",
    version: 1,
    currency: "CNY",
    items: [
      {
        fabricSampleId: UUID_C,
        description: "高支棉 220g",
        quantity: { value: 100, unit: "meter" },
        unitPrice: makeMoney(1000),
        lineTotal: makeMoney(100000),
      },
    ],
    subtotal: makeMoney(100000),
    total: makeMoney(100000),
    amountsComputedByKernel: true,
    validityDays: 30,
    expiresAt: "2026-12-11T11:00:00.000Z",
    createdAt: NOW,
    remarks: null,
    ...overrides,
  };
}
