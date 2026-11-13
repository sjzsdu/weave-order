import { describe, expect, it } from "vitest";
import {
  ApprovalRequirement,
  CreatePricingPolicyInput,
  PricingKey,
  QuoteDraft,
  ReviseQuoteDraftInput,
  ResolvedPricingValue,
  ConfirmQuoteInput,
} from "../src";

const UUID_A = "123e4567-e89b-12d3-a456-426614174000";
const UUID_B = "123e4567-e89b-12d3-a456-426614174001";
const NOW = "2026-11-12T11:00:00.000Z";

describe("Track A 契约：定价继承", () => {
  it("策略键是封闭集合，未知键被拒绝", () => {
    expect(PricingKey.safeParse("pricing.min_margin_pct").success).toBe(true);
    expect(PricingKey.safeParse("pricing.nonexistent").success).toBe(false);
  });

  it("CreatePricingPolicyInput 拒绝夹带未知字段", () => {
    const ok = CreatePricingPolicyInput.safeParse({
      scopeType: "COMPANY",
      key: "pricing.min_margin_pct",
      value: 10,
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.locked).toBe(false);

    expect(
      CreatePricingPolicyInput.safeParse({
        scopeType: "COMPANY",
        key: "pricing.min_margin_pct",
        value: 10,
        tenantId: UUID_A,
      }).success,
    ).toBe(false);
  });

  it("ResolvedPricingValue 同时携带生效值与来源", () => {
    const parsed = ResolvedPricingValue.safeParse({
      key: "pricing.min_margin_pct",
      value: 12,
      source: {
        policyId: UUID_A,
        scopeType: "COMPANY",
        scopeId: null,
        priority: 10,
        locked: true,
        kind: "POLICY",
      },
      clamped: false,
      chain: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("ApprovalRequirement 拒绝未知升级原因", () => {
    expect(
      ApprovalRequirement.safeParse({
        level: "MANAGER",
        role: "MANAGER",
        amountCents: 160_000,
        changePctBps: 667,
        escalated: true,
        reasons: ["REPRICE_PCT_EXCEEDED"],
        policySources: [],
      }).success,
    ).toBe(true);
    expect(
      ApprovalRequirement.safeParse({
        level: "MANAGER",
        role: "MANAGER",
        amountCents: 160_000,
        changePctBps: null,
        escalated: true,
        reasons: ["MADE_UP_REASON"],
        policySources: [],
      }).success,
    ).toBe(false);
  });
});

describe("Track A 契约：改稿", () => {
  it("改稿必须至少改一个字段，并检查 baseVersion", () => {
    expect(
      ReviseQuoteDraftInput.safeParse({
        quoteId: UUID_A,
        baseVersion: 1,
        source: "INLINE",
        instruction: "改价",
      }).success,
    ).toBe(false);

    expect(
      ReviseQuoteDraftInput.safeParse({
        quoteId: UUID_A,
        baseVersion: 1,
        source: "INLINE",
        instruction: "改价",
        lines: [{ lineIndex: 0, unitPrice: { amount: 1600, currency: "CNY" } }],
      }).success,
    ).toBe(true);
  });

  it("QuoteDraft 版本缺省为 1（向后兼容旧调用方）", () => {
    const parsed = QuoteDraft.parse({
      id: UUID_B,
      tenantId: UUID_A,
      customerId: UUID_A,
      status: "DRAFT",
      currency: "CNY",
      items: [
        {
          fabricSampleId: UUID_B,
          description: "面料",
          quantity: { value: 100, unit: "meter" },
          unitPrice: { amount: 1000, currency: "CNY" },
          lineTotal: { amount: 100_000, currency: "CNY" },
        },
      ],
      subtotal: { amount: 100_000, currency: "CNY" },
      total: { amount: 100_000, currency: "CNY" },
      amountsComputedByKernel: true,
      validityDays: 30,
      expiresAt: NOW,
      createdAt: NOW,
      remarks: null,
    });
    expect(parsed.version).toBe(1);
  });

  it("确认入参支持可选乐观锁版本", () => {
    expect(ConfirmQuoteInput.safeParse({ quoteId: UUID_A, baseVersion: 2 }).success).toBe(true);
    expect(ConfirmQuoteInput.safeParse({ quoteId: UUID_A, baseVersion: 0 }).success).toBe(false);
  });
});
