import Taro from "@tarojs/taro";
import { resolveBackAction } from "./lib/back-nav";
import {
  DEFAULT_QUOTE_ENTRY,
  cameraEntrySchema,
  parseCameraMode,
  quoteEntrySchema,
  resolveQuoteEntry,
} from "./lib/entry-params";
import type { CameraEntryParams, CameraMode, QuoteEntryParams } from "./lib/entry-params";
import { prefs } from "./lib/runtime";

/**
 * 移动端导航注册表 —— 唯一事实来源。
 *
 * 以前 `openQuote / openCamera / goTab / openCustomer` 散在页面里，谁都能拼一个
 * URL，tab 与二级页的区别只写在 `app.config.ts` 里，页面无从判断。现在：
 *
 * - 路由表是数据：路径、tab 序号、标题都在这里，`app.config.ts` 的 tabBar 只是它的投影；
 * - 页面不关心自己是 tab 还是二级页，只调用注册表里的动作；
 * - tab 页不能带 query（Taro / 微信都限制），入口参数统一暂存到 prefs 里再切页。
 *
 * 新增路由：在 `ROUTES` 加一条，`app.config.ts` 的 pages 补一行；新增入口动作才写函数。
 */

export const ROUTE_PATHS = {
  today: "/pages/today/index",
  customers: "/pages/customers/index",
  quote: "/pages/quote/index",
  samples: "/pages/samples/index",
  more: "/pages/more/index",
  approvals: "/pages/approvals/index",
  camera: "/pages/camera/index",
  customer: "/pages/customer/index",
  start: "/pages/start/index",
} as const;

export type RoutePath = (typeof ROUTE_PATHS)[keyof typeof ROUTE_PATHS];

export interface RouteDefinition {
  path: RoutePath;
  /** 底部 tab 的顺序（1 起）；二级页为 null。 */
  tab: number | null;
  title: string;
}

export const ROUTES = {
  today: { path: ROUTE_PATHS.today, tab: 1, title: "待办" },
  customers: { path: ROUTE_PATHS.customers, tab: 2, title: "客户" },
  quote: { path: ROUTE_PATHS.quote, tab: 3, title: "开报价" },
  samples: { path: ROUTE_PATHS.samples, tab: 4, title: "样品" },
  more: { path: ROUTE_PATHS.more, tab: 5, title: "我的" },
  approvals: { path: ROUTE_PATHS.approvals, tab: null, title: "审批" },
  camera: { path: ROUTE_PATHS.camera, tab: null, title: "相机" },
  customer: { path: ROUTE_PATHS.customer, tab: null, title: "客户 360" },
  start: { path: ROUTE_PATHS.start, tab: null, title: "开始" },
} as const satisfies Record<string, RouteDefinition>;

export type RouteName = keyof typeof ROUTES;

export type TabPath =
  | typeof ROUTE_PATHS.today
  | typeof ROUTE_PATHS.customers
  | typeof ROUTE_PATHS.quote
  | typeof ROUTE_PATHS.samples
  | typeof ROUTE_PATHS.more;

/** tab 顺序由注册表推导；`app.config.ts` 的 tabBar.list 必须与它一致。 */
export const TAB_ROUTES = (Object.keys(ROUTES) as RouteName[])
  .filter((name) => ROUTES[name].tab !== null)
  .sort((left, right) => (ROUTES[left].tab ?? 0) - (ROUTES[right].tab ?? 0))
  .map((name) => ({
    name,
    path: ROUTES[name].path as TabPath,
    title: ROUTES[name].title,
    tab: ROUTES[name].tab as number,
  }));

export function isTabPath(path: RoutePath): path is TabPath {
  return TAB_ROUTES.some((entry) => entry.path === path);
}

/** 只用于 tab 页；传二级页会在控制台报错并退回 navigateTo（开发期能立刻发现）。 */
export function goTab(path: RoutePath): void {
  if (!isTabPath(path)) {
    console.error(`[routes] ${path} 不是 tab 页，改用 navigateTo`);
    void Taro.navigateTo({ url: path });
    return;
  }
  void Taro.switchTab({ url: path });
}

export function openStart(): void {
  void Taro.reLaunch({ url: ROUTE_PATHS.start });
}

export function openWorkspace(): void {
  void Taro.reLaunch({ url: ROUTE_PATHS.today });
}

export function openApprovals(): void {
  void Taro.navigateTo({ url: ROUTE_PATHS.approvals });
}

export function openCustomer(customerId: string): void {
  const id = customerId.trim();
  if (!id) {
    console.error("[routes] openCustomer 缺少 customerId");
    return;
  }
  void Taro.navigateTo({ url: `${ROUTE_PATHS.customer}?id=${encodeURIComponent(id)}` });
}

/**
 * 报价是 tab 页：`switchTab` 不能带参数，入口参数写进 prefs，报价页 `useDidShow` 时取一次。
 * 这样「待办主按钮 / 客户行 / 样品 / 审批改价」共用一种参数形状，报价页不需要知道来源。
 */
export function enterQuote(params: QuoteEntryParams = DEFAULT_QUOTE_ENTRY): void {
  const parsed = quoteEntrySchema.safeParse(params);
  if (!parsed.success) {
    console.error("[routes] 报价入口参数不合法", parsed.error.issues);
    return;
  }
  prefs.setQuoteEntry(params);
  void Taro.switchTab({ url: ROUTE_PATHS.quote });
}

/** 报价页读取入口参数：本地暂存优先，其次深链 query。读完即清。 */
export function takeQuoteEntry(query: Record<string, string | undefined> = {}): QuoteEntryParams {
  const stored = prefs.takeQuoteEntry();
  return resolveQuoteEntry(stored, query);
}

/**
 * 只有确实暂存过入口时才返回（tab 复用时用来区分「新入口」与「点了 tabbar」）。
 * `takeQuoteEntry` 永远给默认值，适合首次挂载；这个给 `useDidShow` 用。
 */
export function consumeQuoteEntry(query: Record<string, string | undefined> = {}): QuoteEntryParams | null {
  const stored = prefs.takeQuoteEntry();
  if (stored === null) return null;
  return resolveQuoteEntry(stored, query);
}

/** 相机不是 tab 页了：`navigateTo` 带不了参数，模式和以前一样放 prefs，页面 `useDidShow` 取一次。 */
export function enterCamera(params: CameraEntryParams): void {
  const parsed = cameraEntrySchema.safeParse(params);
  if (!parsed.success) {
    console.error("[routes] 相机入口参数不合法", parsed.error.issues);
    return;
  }
  prefs.setCameraMode(parsed.data.mode);
  void Taro.navigateTo({ url: ROUTE_PATHS.camera });
}

/**
 * 返回上一页；页面栈只有一层（直接打开二级页 / PWA 冷启动）时回退到指定 tab。
 * navigateBack 在 H5 也可能失败，失败同样落到 tab，保证任何情况下都有出口。
 */
export function back(fallbackTab: TabPath = ROUTE_PATHS.today): void {
  const pages = typeof Taro.getCurrentPages === "function" ? Taro.getCurrentPages() : [];
  const action = resolveBackAction(pages.length, fallbackTab);
  if (action.kind === "tab") {
    goTab(action.url);
    return;
  }
  void Taro.navigateBack({ delta: 1, fail: () => goTab(fallbackTab) });
}

export { parseCameraMode };
export type { CameraEntryParams, CameraMode, QuoteEntryParams };
export type { QuoteMode } from "./lib/entry-params";
