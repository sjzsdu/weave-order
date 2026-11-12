import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { createQuoteAgentGraph, toQuoteAgentResult } from "../src/agent";
import { LocalRuleLlmProvider } from "../src/platform/llm";
import type { Tools } from "../src/tools";

const CUSTOMER_ID = "123e4567-e89b-12d3-a456-426614174000";
const SAMPLE_IDS = [
  "123e4567-e89b-12d3-a456-426614174001",
  "123e4567-e89b-12d3-a456-426614174002",
  "123e4567-e89b-12d3-a456-426614174003",
];
const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const NOW = "2026-11-12T00:00:00.000Z";

const samples = SAMPLE_IDS.map((id, index) => ({
  id,
  tenantId: TENANT_ID,
  code: `S-${index + 1}`,
  name: `${220 + index}g 棉汗布`,
  composition: "100% 棉",
  weight: `${220 + index}g/m2`,
  unit: "meter" as const,
  costFloor: { amount: 1200, currency: "CNY" as const },
  status: "ACTIVE" as const,
  createdAt: NOW,
}));

const customer = {
  id: CUSTOMER_ID,
  tenantId: TENANT_ID,
  code: "C-1",
  name: "测试客户",
  tier: "VIP" as const,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
};

const fakeTools = {
  getCustomerHistory: {
    execute: () =>
      Promise.resolve({
        ok: true,
        data: {
          customer,
          context: {
            customerId: CUSTOMER_ID,
            preferenceNotes: [],
            pricingBehavior: {
              sensitivity: "MEDIUM",
              counterofferAcceptanceRate: null,
              typicalAcceptanceWindowDays: null,
              notes: [],
            },
            paymentPattern: {
              preferredTerms: null,
              onTimeRate: null,
              averageDelayDays: null,
              notes: [],
            },
            followupPreference: {
              preferredChannel: null,
              preferredTimeWindow: null,
              avoidDays: [],
              notes: [],
            },
            decisionDeltas: [],
            updatedAt: NOW,
          },
          recentQuotes: [],
          recentOrders: [],
          recentSamples: [],
        },
      }),
  },
  searchFabricBySpec: {
    execute: () =>
      Promise.resolve({
        ok: true,
        data: {
          matches: samples.map((sample) => ({
            sample,
            score: 0.5,
            matchedOn: ["name", "weight"] as ("code" | "name" | "composition" | "weight")[],
          })),
        },
      }),
  },
  searchFabricByImage: {
    execute: () => Promise.resolve({ ok: true, data: { matches: [] } }),
  },
  suggestLinePrice: {
    execute: () =>
      Promise.resolve({
        ok: true,
        data: {
          pricing: {
            customerId: CUSTOMER_ID,
            fabricSampleId: SAMPLE_IDS[0],
            currency: "CNY" as const,
            quantity: { value: 500, unit: "meter" as const },
            costFloor: { amount: 1200, currency: "CNY" as const },
            markupRateBps: 1200,
            suggestedUnitPrice: { amount: 1400, currency: "CNY" as const },
            components: [
              {
                kind: "COST_FLOOR" as const,
                label: "样品成本底线",
                amount: { amount: 1200, currency: "CNY" as const },
                rateBps: null,
                source: "samples.cost_floor",
                note: null,
              },
            ],
            computedBy: "KERNEL" as const,
          },
        },
      }),
  },
  generateQuoteDraft: {
    execute: (input: { items: { unitPrice: { amount: number } }[] }) =>
      Promise.resolve({
        ok: true,
        data: {
          draft: {
            id: "123e4567-e89b-12d3-a456-426614174099",
            tenantId: TENANT_ID,
            customerId: CUSTOMER_ID,
            status: "DRAFT" as const,
            currency: "CNY" as const,
            items: [
              {
                fabricSampleId: SAMPLE_IDS[0],
                description: "220g 棉汗布",
                quantity: { value: 500, unit: "meter" as const },
                unitPrice: {
                  amount: input.items[0]?.unitPrice.amount ?? 1400,
                  currency: "CNY" as const,
                },
                lineTotal: { amount: 700000, currency: "CNY" as const },
              },
            ],
            subtotal: { amount: 700000, currency: "CNY" as const },
            total: { amount: 700000, currency: "CNY" as const },
            amountsComputedByKernel: true as const,
            validityDays: 30,
            expiresAt: NOW,
            createdAt: NOW,
            remarks: null,
          },
        },
      }),
  },
} as unknown as Tools;

function buildGraph() {
  return createQuoteAgentGraph({
    tools: fakeTools,
    llm: new LocalRuleLlmProvider(() => new Date(NOW)),
    checkpointer: new MemorySaver(),
  });
}

describe("找样 / 报价 agent（原话 → 候选 → DRAFT）", () => {
  it("解析槽位、返回 3 个带理由的候选、出 DRAFT 与定价依据", async () => {
    const graph = buildGraph();
    const state = await graph.invoke(
      {
        threadId: "unit-quote",
        rawText: "这款 220g 棉的，要 500 米，什么价",
        customerId: CUSTOMER_ID,
        currency: "CNY",
        topK: 3,
      },
      { configurable: { thread_id: "unit-quote" } },
    );

    expect(state.stage).toBe("DONE");
    expect(state.intent?.slots.composition).toBe("棉");
    expect(state.intent?.slots.quantity).toEqual({ value: 500, unit: "meter" });
    expect(state.candidates).toHaveLength(3);
    expect(state.candidates[0]?.rationale).toContain("命中");
    expect(state.pricingBasis?.suggestedUnitPrice.amount).toBe(1400);
    expect(state.draft?.status).toBe("DRAFT");
    expect(state.draft?.amountsComputedByKernel).toBe(true);

    const result = toQuoteAgentResult(state);
    expect(result.status).toBe("DRAFTED");
  });

  it("没有客户 / 数量时明确列缺失项，不生成草稿", async () => {
    const graph = buildGraph();
    const state = await graph.invoke(
      { threadId: "unit-missing", rawText: "这款棉的什么价", currency: "CNY" },
      { configurable: { thread_id: "unit-missing" } },
    );

    expect(state.draft).toBeNull();
    expect(state.missingFields.map((field) => field.code)).toEqual(
      expect.arrayContaining(["CUSTOMER", "QUANTITY"]),
    );
    expect(toQuoteAgentResult(state).status).toBe("NEEDS_INPUT");
  });

  it("空原话以 INVALID_INPUT 失败，不伪造草稿", async () => {
    const graph = buildGraph();
    const state = await graph.invoke(
      { threadId: "unit-empty", rawText: "", currency: "CNY" },
      { configurable: { thread_id: "unit-empty" } },
    );
    expect(state.stage).toBe("FAILED");
    expect(state.failure?.code).toBe("INVALID_INPUT");
    expect(state.draft).toBeNull();
  });
});
