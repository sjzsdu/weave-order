import { describe, expect, it } from "vitest";
import { hasApprovalCapability, roleApprovalLevel } from "@weave-order/schema";
import type {
  ApprovalRequirement,
  MemberRole,
  PricingKey,
  ResolvedPricingValue,
} from "@weave-order/schema";
import { assertCanApprove, computeRequirement } from "../src/kernel/approval-policy";
import { KernelError } from "../src/kernel/errors";

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

  it("AUTH_MODE=oidc 的 staging 同样 fail-closed，不回退 OWNER", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAuthMode = process.env.AUTH_MODE;
    process.env.NODE_ENV = "development";
    process.env.AUTH_MODE = "oidc";
    try {
      const requirement = computeRequirement({
        amountCents: 100_000,
        baselineCents: null,
        policies: DEFAULT_POLICIES,
      });
      expect(() => assertCanApprove(undefined, requirement)).toThrowError(/缺少审批人角色/);
      expect(() => assertCanApprove("SALES", requirement)).not.toThrow();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousAuthMode;
    }
  });
});

/** 捕获 assertCanApprove 抛出的错误码；未抛时返回 null。 */
function denyCode(
  role: MemberRole,
  requirement: ApprovalRequirement,
  approvalLimitAmount?: number | null,
): string | null {
  try {
    assertCanApprove(role, requirement, approvalLimitAmount);
    return null;
  } catch (error) {
    return error instanceof KernelError ? error.code : (error as Error).name;
  }
}

describe("审批能力白名单：能力与等级分离", () => {
  it.each<[MemberRole, boolean, string | null]>([
    ["OWNER", true, "OWNER"],
    ["MANAGER", true, "MANAGER"],
    ["SALES", true, "SALES"],
    ["MERCHANDISER", false, null],
    ["SAMPLE_ADMIN", false, null],
    ["FINANCE", false, null],
    ["VIEWER", false, null],
  ])("%s 具备能力=%s 等级=%s", (role, capable, level) => {
    expect(hasApprovalCapability(role)).toBe(capable);
    expect(roleApprovalLevel(role)).toBe(level);
  });
});

describe("确认路径：只有 OWNER/MANAGER/SALES 能走到 confirm", () => {
  const salesRequirement = computeRequirement({
    amountCents: 4_999_999,
    baselineCents: null,
    policies: DEFAULT_POLICIES,
  });

  it.each<[MemberRole, boolean]>([
    ["OWNER", true],
    ["MANAGER", true],
    ["SALES", true],
    ["MERCHANDISER", false],
    ["SAMPLE_ADMIN", false],
    ["FINANCE", false],
    ["VIEWER", false],
  ])("%s 能走到 confirm = %s", (role, expected) => {
    expect(denyCode(role, salesRequirement)).toBe(expected ? null : "PERMISSION_DENIED");
  });

  it("FINANCE 批准 ≤20 万报价必须 PERMISSION_DENIED", () => {
    const requirement = computeRequirement({
      amountCents: 20_000_000,
      baselineCents: null,
      policies: DEFAULT_POLICIES,
    });
    expect(requirement.level).toBe("MANAGER");
    expect(denyCode("FINANCE", requirement)).toBe("PERMISSION_DENIED");
  });

  it("VIEWER / SAMPLE_ADMIN / MERCHANDISER 同理", () => {
    const requirement = computeRequirement({
      amountCents: 20_000_000,
      baselineCents: null,
      policies: DEFAULT_POLICIES,
    });
    for (const role of ["VIEWER", "SAMPLE_ADMIN", "MERCHANDISER"] as const) {
      expect(denyCode(role, requirement)).toBe("PERMISSION_DENIED");
    }
  });
});

describe("成员级审批额度参与判定", () => {
  it("成员额度 5000 时，SALES 不能批准 30000 的报价（即使角色等级够）", () => {
    const requirement = computeRequirement({
      amountCents: 30_000,
      baselineCents: null,
      policies: DEFAULT_POLICIES,
    });
    expect(requirement.level).toBe("SALES");
    expect(denyCode("SALES", requirement, 5_000)).toBe("PERMISSION_DENIED");
  });

  it("未配置额度时回落到公司阈值（角色等级判定）", () => {
    const requirement = computeRequirement({
      amountCents: 30_000,
      baselineCents: null,
      policies: DEFAULT_POLICIES,
    });
    expect(denyCode("SALES", requirement, null)).toBeNull();
    expect(denyCode("SALES", requirement, undefined)).toBeNull();
  });
});
