import { describe, expect, it, vi } from "vitest";

/**
 * 路由注册表的回归：tab 顺序、tab / 二级页的划分。
 * Taro 与运行时偏好用最小桩替换，测的是注册表本身的数据，不渲染页面。
 */
vi.mock("@tarojs/taro", () => ({
  default: {
    switchTab: vi.fn(() => Promise.resolve()),
    navigateTo: vi.fn(() => Promise.resolve()),
    reLaunch: vi.fn(() => Promise.resolve()),
    navigateBack: vi.fn(() => Promise.resolve()),
    getCurrentPages: vi.fn(() => []),
  },
}));

vi.mock("../src/lib/runtime", () => ({
  prefs: {
    setQuoteEntry: vi.fn(),
    takeQuoteEntry: vi.fn(() => null),
    setCameraMode: vi.fn(),
  },
}));

describe("导航注册表", () => {
  it("底部 tab 依次为：待办、客户、开报价、样品、我的", async () => {
    const { TAB_ROUTES } = await import("../src/routes");
    expect(TAB_ROUTES.map((entry) => entry.title)).toEqual([
      "待办",
      "客户",
      "开报价",
      "样品",
      "我的",
    ]);
    expect(TAB_ROUTES.map((entry) => entry.tab)).toEqual([1, 2, 3, 4, 5]);
  });

  it("审批与相机不在 tab 上，但仍是合法路由", async () => {
    const { ROUTES, isTabPath, ROUTE_PATHS } = await import("../src/routes");
    expect(ROUTES.approvals.tab).toBeNull();
    expect(ROUTES.camera.tab).toBeNull();
    expect(isTabPath(ROUTE_PATHS.approvals)).toBe(false);
    expect(isTabPath(ROUTE_PATHS.camera)).toBe(false);
    expect(isTabPath(ROUTE_PATHS.today)).toBe(true);
  });

  it("tab 路径唯一，且都在 ROUTE_PATHS 里", async () => {
    const { TAB_ROUTES, ROUTE_PATHS } = await import("../src/routes");
    const paths = TAB_ROUTES.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    const known = new Set(Object.values(ROUTE_PATHS));
    for (const path of paths) expect(known.has(path)).toBe(true);
  });

  it("每个 tab 都有中文标题，二级页标题不为空", async () => {
    const { ROUTES } = await import("../src/routes");
    for (const route of Object.values(ROUTES)) {
      expect(route.title.trim().length).toBeGreaterThan(0);
      expect(route.path.startsWith("/pages/")).toBe(true);
    }
  });
});
