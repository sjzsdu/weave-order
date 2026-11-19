import Taro from "@tarojs/taro";
import { prefs } from "./runtime";
import { resolveBackAction } from "./back-nav";

export const ROUTES = {
  today: "/pages/today/index",
  approvals: "/pages/approvals/index",
  camera: "/pages/camera/index",
  customers: "/pages/customers/index",
  more: "/pages/more/index",
  quote: "/pages/quote/index",
  customer: "/pages/customer/index",
  start: "/pages/start/index",
} as const;

export function goTab(page: (typeof ROUTES)[keyof typeof ROUTES]): void {
  void Taro.switchTab({ url: page });
}

export function openStart(): void {
  void Taro.reLaunch({ url: ROUTES.start });
}

export function openWorkspace(): void {
  void Taro.reLaunch({ url: ROUTES.today });
}

/** 报价入口模式：决定预填什么，不决定权限。 */
export type QuoteMode = "paste" | "camera" | "sample" | "customer" | "edit";

export interface QuoteEntryParams {
  mode: QuoteMode;
  sampleId?: string;
  customerId?: string;
  quoteId?: string;
}

/**
 * 所有报价入口的唯一形状（待办主按钮、客户行、样品「用它报价」、审批「改价」）。
 * 参数语义收在一处，新增入口只加调用点，不加新函数。
 */
export function enterQuote(params: QuoteEntryParams = { mode: "paste" }): void {
  const search = new URLSearchParams();
  search.set("mode", params.mode);
  if (params.customerId) search.set("customerId", params.customerId);
  if (params.sampleId) search.set("sampleId", params.sampleId);
  if (params.quoteId) search.set("quoteId", params.quoteId);
  void Taro.navigateTo({ url: `${ROUTES.quote}?${search.toString()}` });
}

/** 兼容旧调用名；实现只有 `enterQuote` 一份。 */
export const openQuote = enterQuote;

export function openCustomer(customerId: string): void {
  void Taro.navigateTo({ url: `${ROUTES.customer}?id=${encodeURIComponent(customerId)}` });
}

/** tabBar 页不能带参数：把相机模式放偏好里，切页后读取一次。 */
export function openCamera(mode: string): void {
  prefs.setCameraMode(mode);
  goTab(ROUTES.camera);
}

/**
 * 返回上一页；页面栈只有一层（直接打开二级页 / PWA 冷启动）时回退到指定 tab。
 * navigateBack 在 H5 也可能失败，失败同样落到 tab，保证任何情况下都有出口。
 */
export function back(fallbackTab: (typeof ROUTES)[keyof typeof ROUTES] = ROUTES.today): void {
  const pages = typeof Taro.getCurrentPages === "function" ? Taro.getCurrentPages() : [];
  const action = resolveBackAction(pages.length, fallbackTab);
  if (action.kind === "tab") {
    goTab(action.url);
    return;
  }
  void Taro.navigateBack({ delta: 1, fail: () => goTab(fallbackTab) });
}
