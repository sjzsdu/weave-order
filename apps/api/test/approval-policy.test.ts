import { describe, expect, it } from "vitest";
import type { PricingKey, ResolvedPricingValue } from "@weave-order/schema";
import { assertCanApprove, computeRequirement } from "../src/kernel/approval-policy";

/**
 * 审批金额阈值与改幅升级的纯函数测试（不依赖数据库）。
 * 默认：业务员 5 万、主管 20 万、超出老板；改幅 > 5% 升级主管。
 */
function policy(key: PricingKey, value: number | null): ResolvedPricingValue {
  return {
    key,
    value,
    source: {
      policyId: null,
      scopeType: "SYSTEM",
      scopeId: null,
      priority: 0,
      locked: false,
      kind: "SYSTEM_DEFAULT",
    },
    clamped: false,
    chain: [],
  };
}

const DEFAULT_POLICIES: Partial<Record<PricingKey, ResolvedPricingValue>> = {
  "approval.sales.limit": policy("approval.sales.limit", 5_000_000),
  "approval.manager.limit": policy("approval.manager.limit", 20_000_000),
  "approval.owner.limit": policy("approval.owner.limit", null),
  "pricing.reprice_escalation_pct": policy("pricing.reprice_escalation_pct", 5),
  "pricing.reprice_escalation_amount": policy("pricing.reprice_escalation_amount", 1_000_000),
};

describe("审批金额阈值（owner / manager / sales 分级）", () => {
  it("5 万以内 → 业务员", () => {
    const requirement = computeRequirement({
      amountCents: 4_999_999,
      baselineCents: null,
      policies: DEFAULT_POLICIES,
    });
    expect(requirement.level).toBe("SALES");
    expect(requirement.role).toBe("SALES");
    expect(requirement.escalated).toBe(false);
  });

  it("5 万~20 万 → 主管", () => {
    const requirement = computeRequirement({
      amountCents: 5_000_001,
      baselineCents: null,
      policies: DEFAULT_POLICIES,
    });
    expect(requirement.level).toBe("MANAGER");
    expect(requirement.escalated).toBe(true);
  });

  it("超过 20 万 → 老板", () => {
    const requirement = computeRequirement({
      amountCents: 20_000_001,
      baselineCents: null,
      policies: DEFAULT_POLICIES,
    });
    expect(requirement.level).toBe("OWNER");
    expect(requirement.reasons).not.toContain("REPRICE_PCT_EXCEEDED");
  });

  it("金额很小但改幅超 5% → 自动升级主管", () => {
    const requirement = computeRequirement({
      amountCents: 106_000,
      baselineCents: 100_000,
      policies: DEFAULT_POLICIES,
    });
    expect(requirement.changePctBps).toBe(600);
    expect(requirement.level).toBe("MANAGER");
    expect(requirement.reasons).toContain("REPRICE_PCT_EXCEEDED");
  });

  it("改幅金额超过阈值（1 万元）也升级主管", () => {
    const requirement = computeRequirement({
      amountCents: 2_100_000,
      baselineCents: 1_000_000,
      policies: DEFAULT_POLICIES,
    });
    expect(requirement.reasons).toContain("REPRICE_AMOUNT_EXCEEDED");
    expect(requirement.level).toBe("MANAGER");
  });

  it("阈值策略可被公司层改写（更严格的业务员上限）", () => {
    const requirement = computeRequirement({
      amountCents: 1_000_000,
      baselineCents: null,
      policies: {
        ...DEFAULT_POLICIES,
        "approval.sales.limit": policy("approval.sales.limit", 500_000),
      },
    });
    expect(requirement.level).toBe("MANAGER");
  });

  it("生产环境缺少审批人角色时 fail-closed", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const requirement = computeRequirement({
        amountCents: 100_000,
        baselineCents: null,
        policies: DEFAULT_POLICIES,
      });
      expect(() => assertCanApprove(undefined, requirement)).toThrowError(/缺少审批人角色/);
      expect(() => assertCanApprove("SALES", requirement)).not.toThrow();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
