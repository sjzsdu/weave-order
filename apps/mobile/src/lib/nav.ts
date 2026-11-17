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

export function openQuote(
  params: {
    customerId?: string;
    sampleId?: string;
    mode?: "paste" | "voice" | "camera";
  } = {},
): void {
  const search = new URLSearchParams();
  if (params.customerId) search.set("customerId", params.customerId);
  if (params.sampleId) search.set("sampleId", params.sampleId);
  if (params.mode) search.set("mode", params.mode);
  const suffix = search.toString();
  void Taro.navigateTo({ url: `${ROUTES.quote}${suffix ? `?${suffix}` : ""}` });
}

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
