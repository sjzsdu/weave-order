import { describe, expect, it } from "vitest";
import {
  Capability,
  CAPABILITY_ROLES,
  approvalLevelForRole,
  hasApprovalCapability,
  hasCapability,
  hasQuoteEditCapability,
  roleApprovalLevel,
  roleCapabilities,
} from "../src";
import type { MemberRole } from "../src";

/**
 * 权限矩阵的独立预言机（oracle）。
 *
 * 这里按 `docs/product-design.md` §3.3 的表格 + 本轮收敛前的 5 处实现逐行手写，
 * 不 import `CAPABILITY_ROLES` 推导：实现写错了测试不能跟着错。
 * 新增能力时先在这里补一行，否则 `覆盖全部能力` 用例会红。
 */
const ALL_ROLES: MemberRole[] = [
  "OWNER",
  "MANAGER",
  "SALES",
  "MERCHANDISER",
  "SAMPLE_ADMIN",
  "FINANCE",
  "VIEWER",
];

const EXPECTED: Record<MemberRole, Capability[]> = {
  OWNER: [...Capability.options],
  MANAGER: [
    "sample.write",
    "sample.cost.view",
    "quote.write",
    "quote.approve",
    "quote.confirm",
    "quote.price.override",
    "pricing.cross_person.read",
    "pricing.policy.edit",
    "member.invite",
    "settings.edit",
    "print.execute",
    "receivable.read",
    "panorama.orders.view",
    "audit.read.all",
    "audit.read.own",
    "contact.pii.view",
    "quote.workbench.view",
    "field_options.manage",
    "data.import",
  ],
  // 业务员：能改稿、能批到自己那一档、能看应收与订单；看不到成本、不能配置。
  SALES: [
    "quote.write",
    "quote.approve",
    "print.execute",
    "receivable.read",
    "panorama.orders.view",
    "audit.read.own",
    "contact.pii.view",
    "quote.workbench.view",
    "field_options.manage",
    "data.import",
  ],
  // 跟单：只读业务流，不碰价格、权限、成本。
  MERCHANDISER: [
    "print.execute",
    "panorama.orders.view",
    "audit.read.own",
    "contact.pii.view",
    "field_options.manage",
    "data.import",
    "print.execute",
  ],
  // 样品管理：维护样品（含成本底线），但不做报价与审批。
  SAMPLE_ADMIN: [
    "sample.write",
    "sample.cost.view",
    "print.execute",
    "panorama.orders.view",
    "audit.read.own",
    "contact.pii.view",
    "field_options.manage",
    "data.import",
  ],
  // 财务：成本与应收是工作面；订单漏斗不在一级入口。
  FINANCE: [
    "sample.cost.view",
    "print.execute",
    "receivable.read",
    "audit.read.own",
    "contact.pii.view",
    "field_options.manage",
    "print.execute",
  ],
  // 只读席位：读得到业务与应收，改不了；成本底线沿用收敛前的不可见。
  // 联系人手机/邮箱是唯一按角色掩码的字段（巧匠 WAN-174 第 3 条），因此 VIEWER 没有 contact.pii.view。
  VIEWER: [
    "print.execute",
    "receivable.read",
    "panorama.orders.view",
    "audit.read.own",
    "quote.workbench.view",
    "field_options.manage",
  ],
};

describe("能力表：7 角色 × 全部能力", () => {
  const cases = ALL_ROLES.flatMap((role) =>
    Capability.options.map((capability) => ({
      role,
      capability,
      allowed: EXPECTED[role].includes(capability),
    })),
  );

  it("每个枚举能力都有用例覆盖（新增能力必须补预言机）", () => {
    expect(new Set(cases.map((entry) => entry.capability))).toEqual(new Set(Capability.options));
  });

  it.each(cases)("$role / $capability → $allowed", ({ role, capability, allowed }) => {
    expect(hasCapability(role, capability)).toBe(allowed);
    // 反向查表必须与正向判定一致，避免两张表各说各话。
    expect(CAPABILITY_ROLES[capability].includes(role)).toBe(allowed);
  });

  it.each(ALL_ROLES)("%s 的 roleCapabilities 与逐项判定一致", (role) => {
    expect(roleCapabilities({ role })).toEqual(
      Capability.options.filter((capability) => EXPECTED[role].includes(capability)),
    );
  });

  it("接受完整成员形状（membership 直传，不必先取 role）", () => {
    const membership = {
      role: "SALES" as const,
      dataScope: "OWN" as const,
      approvalLimitAmount: 5_000_000,
    };
    expect(hasCapability(membership, "quote.approve")).toBe(true);
    expect(hasCapability(membership, "sample.cost.view")).toBe(false);
    expect(roleCapabilities(membership)).toEqual(EXPECTED.SALES);
  });
});

describe("产品矩阵的硬规则（回归旧实现的行为）", () => {
  it("样品可写必然可看成本：可写不可读会让编辑器把 null 回写", () => {
    for (const role of ALL_ROLES) {
      if (!hasCapability(role, "sample.write")) continue;
      expect(hasCapability(role, "sample.cost.view")).toBe(true);
    }
  });

  it("成本可见集与收敛前一致：owner / manager / finance / sample_admin", () => {
    expect(ALL_ROLES.filter((role) => hasCapability(role, "sample.cost.view")).sort()).toEqual(
      ["OWNER", "MANAGER", "FINANCE", "SAMPLE_ADMIN"].sort(),
    );
  });

  it("样品写集与收敛前一致：owner / manager / sample_admin", () => {
    expect(ALL_ROLES.filter((role) => hasCapability(role, "sample.write")).sort()).toEqual(
      ["OWNER", "MANAGER", "SAMPLE_ADMIN"].sort(),
    );
  });

  it("跨人查看定价只有 owner / manager", () => {
    expect(ALL_ROLES.filter((role) => hasCapability(role, "pricing.cross_person.read"))).toEqual([
      "OWNER",
      "MANAGER",
    ]);
  });

  it("全景订单对财务隐藏，其余角色可见", () => {
    expect(ALL_ROLES.filter((role) => hasCapability(role, "panorama.orders.view"))).toEqual([
      "OWNER",
      "MANAGER",
      "SALES",
      "MERCHANDISER",
      "SAMPLE_ADMIN",
      "VIEWER",
    ]);
  });

  it("审计范围：只有 owner / manager 能看全公司，其余角色都能看自己", () => {
    expect(ALL_ROLES.filter((role) => hasCapability(role, "audit.read.all"))).toEqual([
      "OWNER",
      "MANAGER",
    ]);
    expect(ALL_ROLES.filter((role) => hasCapability(role, "audit.read.own"))).toEqual(ALL_ROLES);
    // 能看全公司必然能看自己，反之不成立。
    for (const role of ALL_ROLES) {
      if (hasCapability(role, "audit.read.all")) {
        expect(hasCapability(role, "audit.read.own")).toBe(true);
      }
    }
  });

  it("联系人 PII 只对只读席位掩码（WAN-174 巧匠第 3 条）", () => {
    expect(ALL_ROLES.filter((role) => !hasCapability(role, "contact.pii.view"))).toEqual([
      "VIEWER",
    ]);
  });

  it("字段选项对全部角色开放", () => {
    expect(ALL_ROLES.filter((role) => hasCapability(role, "field_options.manage"))).toEqual(
      ALL_ROLES,
    );
  });
});

describe("审批能力与等级", () => {
  it("能力与等级同源：有 quote.approve 才有等级，反之亦然", () => {
    for (const role of ALL_ROLES) {
      const level = approvalLevelForRole(role);
      expect(level === null).toBe(!hasCapability(role, "quote.approve"));
      expect(roleApprovalLevel(role)).toBe(level);
      expect(hasApprovalCapability(role)).toBe(level !== null);
    }
  });

  it("等级阶梯 OWNER > MANAGER > SALES，其余为 null", () => {
    expect(roleApprovalLevel("OWNER")).toBe("OWNER");
    expect(roleApprovalLevel("MANAGER")).toBe("MANAGER");
    expect(roleApprovalLevel("SALES")).toBe("SALES");
    for (const role of ["MERCHANDISER", "SAMPLE_ADMIN", "FINANCE", "VIEWER"] as const) {
      expect(roleApprovalLevel(role)).toBeNull();
    }
  });

  it("改稿能力沿用 quote.write 的同一张表", () => {
    expect(ALL_ROLES.filter((role) => hasQuoteEditCapability(role))).toEqual([
      "OWNER",
      "MANAGER",
      "SALES",
    ]);
  });
});
