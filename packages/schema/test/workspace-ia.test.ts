import { describe, expect, it } from "vitest";
import {
  LEGACY_BUSINESS_NAV,
  LEGACY_PRIMARY_NAV,
  RESOURCE_NAV,
  WORKSPACE_NAV,
  isNavItemActive,
  resolveWorkspaceIA,
} from "../src";

describe("工作台 IA 灰度开关", () => {
  it("缺省为新 IA（事项首页），老租户不需要改任何配置", () => {
    expect(resolveWorkspaceIA(null)).toBe("new");
    expect(resolveWorkspaceIA({})).toBe("new");
    expect(resolveWorkspaceIA({ workspaceIA: "new" })).toBe("new");
  });

  it("租户设置 workspaceIA=legacy 时回旧 IA", () => {
    expect(resolveWorkspaceIA({ workspaceIA: "legacy" })).toBe("legacy");
    // 只认 legacy：别的值一律按新 IA，避免一个拼错的设置把界面弄成半新半旧。
    expect(resolveWorkspaceIA({ workspaceIA: "旧" })).toBe("new");
    expect(resolveWorkspaceIA([{ workspaceIA: "legacy" }])).toBe("new");
    expect(resolveWorkspaceIA("legacy")).toBe("new");
  });

  it("会话级 cookie 覆盖优先于租户设置，非法值忽略", () => {
    expect(resolveWorkspaceIA({ workspaceIA: "legacy" }, "new")).toBe("new");
    expect(resolveWorkspaceIA({ workspaceIA: "new" }, "legacy")).toBe("legacy");
    expect(resolveWorkspaceIA({ workspaceIA: "new" }, "LEGACY")).toBe("new");
    expect(resolveWorkspaceIA({ workspaceIA: "legacy" }, "garbage")).toBe("legacy");
  });
});

describe("新 IA 导航声明", () => {
  it("一级入口固定为 工作台 / 事项 / 资源 / 设置，审批不再占一级", () => {
    expect(WORKSPACE_NAV.map((item) => [item.href, item.label, item.key])).toEqual([
      ["/workbench", "工作台", undefined],
      ["/items", "事项", "1"],
      ["/resources", "资源", "2"],
      ["/settings", "设置", "3"],
    ]);
    expect(WORKSPACE_NAV.some((item) => item.href === "/approvals")).toBe(false);
  });

  it("资源二级导航覆盖客户 / 样品 / 模板，且与旧业务路由同源", () => {
    expect(RESOURCE_NAV.map((item) => item.href)).toEqual([
      "/resources",
      "/panorama/customers",
      "/panorama/samples",
      "/resources/templates",
    ]);
    // 旧路由保留：深链不迁移，只改入口。
    expect(LEGACY_BUSINESS_NAV.some((item) => item.href === "/panorama/customers")).toBe(true);
    expect(LEGACY_PRIMARY_NAV.some((item) => item.href === "/today")).toBe(true);
  });

  it("资源入口点亮 /panorama 深链；事项入口点亮详情页", () => {
    expect(isNavItemActive("/resources", "/resources")).toBe(true);
    expect(isNavItemActive("/resources", "/panorama/customers/abc")).toBe(true);
    expect(isNavItemActive("/resources", "/settings")).toBe(false);
    expect(isNavItemActive("/items", "/items/abc")).toBe(true);
    // 旧 IA 下 /panorama 归旧「业务」入口，不点亮资源。
    expect(isNavItemActive("/resources", "/panorama", "legacy")).toBe(false);
    // 旧业务概览仍保持精确匹配：二级页不点亮「概览」。
    expect(isNavItemActive("/panorama", "/panorama/customers", "legacy")).toBe(false);
    expect(isNavItemActive("/panorama", "/panorama")).toBe(true);
  });
});
