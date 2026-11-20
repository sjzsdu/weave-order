import { describe, expect, it } from "vitest";
import {
  BUSINESS_NAV,
  Capability,
  PRIMARY_NAV,
  SETTINGS_SECTIONS,
  roleCapabilities,
  visibleNav,
} from "../src";
import type { NavItem } from "../src";
import type { MemberRole } from "../src";

const ALL_ROLES: MemberRole[] = [
  "OWNER",
  "MANAGER",
  "SALES",
  "MERCHANDISER",
  "SAMPLE_ADMIN",
  "FINANCE",
  "VIEWER",
];

const ALL_NAV: NavItem[] = [...PRIMARY_NAV, ...BUSINESS_NAV, ...SETTINGS_SECTIONS];

/**
 * 导航矩阵的独立预言机：按 WAN-174 §4.4 手写「角色 → 可见 href」，
 * 不从 `CAPABILITY_ROLES` 推导——实现写错时测试不能跟着错。
 */
const EXPECTED: Record<MemberRole, string[]> = {
  OWNER: ALL_NAV.map((item) => item.href),
  MANAGER: ALL_NAV.map((item) => item.href).filter((href) => href !== "/settings?section=billing"),
  SALES: [
    "/today",
    "/approvals",
    "/panorama",
    "/logs",
    "/panorama",
    "/panorama/customers",
    "/panorama/samples",
    "/panorama/quotes",
    "/panorama/orders",
    "/panorama/receivables",
    "/settings?section=fields",
    "/settings?section=import",
    "/settings?section=audit",
  ],
  MERCHANDISER: [
    "/today",
    "/panorama",
    "/logs",
    "/panorama",
    "/panorama/customers",
    "/panorama/samples",
    "/panorama/orders",
    "/settings?section=fields",
    "/settings?section=import",
    "/settings?section=audit",
  ],
  SAMPLE_ADMIN: [
    "/today",
    "/panorama",
    "/logs",
    "/panorama",
    "/panorama/customers",
    "/panorama/samples",
    "/panorama/orders",
    "/settings?section=fields",
    "/settings?section=import",
    "/settings?section=audit",
  ],
  FINANCE: [
    "/today",
    "/panorama",
    "/logs",
    "/panorama",
    "/panorama/customers",
    "/panorama/samples",
    "/panorama/receivables",
    "/settings?section=fields",
    "/settings?section=audit",
  ],
  VIEWER: [
    "/today",
    "/panorama",
    "/logs",
    "/panorama",
    "/panorama/customers",
    "/panorama/samples",
    "/panorama/quotes",
    "/panorama/orders",
    "/panorama/receivables",
    "/settings?section=fields",
    "/settings?section=audit",
  ],
};

function visibleHrefs(role: MemberRole): string[] {
  const caps = roleCapabilities({ role });
  return [
    ...visibleNav(PRIMARY_NAV, caps),
    ...visibleNav(BUSINESS_NAV, caps),
    ...visibleNav(SETTINGS_SECTIONS, caps),
  ].map((item) => item.href);
}

describe("导航声明", () => {
  it("每个带能力的导航项都引用真实存在的能力（拼错会让入口永久隐藏）", () => {
    for (const item of ALL_NAV) {
      if (!item.requiredCapability) continue;
      expect(Capability.options).toContain(item.requiredCapability);
    }
  });

  it("一级入口与快捷键固定为 工作台/审批/业务/日志", () => {
    expect(PRIMARY_NAV.map((item) => [item.href, item.key])).toEqual([
      ["/today", "1"],
      ["/approvals", "2"],
      ["/panorama", "3"],
      ["/logs", "4"],
    ]);
  });

  it("业务二级导航保持 /panorama/* 路径，不引入 /business/*", () => {
    expect(BUSINESS_NAV.every((item) => item.href.startsWith("/panorama"))).toBe(true);
  });

  it.each(ALL_ROLES)("%s 的可见导航 = WAN-174 §4.4 矩阵", (role) => {
    expect(visibleHrefs(role)).toEqual(EXPECTED[role]);
  });

  it("没有任何角色的菜单能超出自己的能力集合（前端藏了后端还能调的反面）", () => {
    for (const role of ALL_ROLES) {
      const caps = new Set(roleCapabilities({ role }));
      for (const item of ALL_NAV) {
        const visible = visibleNav([item], [...caps]).length > 0;
        expect(visible).toBe(!item.requiredCapability || caps.has(item.requiredCapability));
      }
    }
  });
});

describe("visibleNav 边界", () => {
  it("无 requiredCapability 的项对空能力集也可见", () => {
    expect(visibleNav([{ href: "/today", label: "工作台" }], [])).toHaveLength(1);
  });

  it("缺能力即隐藏，不做模糊/前缀匹配", () => {
    expect(
      visibleNav([{ href: "/logs", label: "日志", requiredCapability: "audit.read.own" }], []),
    ).toEqual([]);
    expect(
      visibleNav(
        [{ href: "/logs", label: "日志", requiredCapability: "audit.read.all" }],
        ["audit.read.own"],
      ),
    ).toEqual([]);
  });
});
