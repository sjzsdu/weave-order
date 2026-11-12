import Taro from "@tarojs/taro";
import { prefs } from "./runtime";

export const ROUTES = {
  today: "/pages/today/index",
  approvals: "/pages/approvals/index",
  camera: "/pages/camera/index",
  customers: "/pages/customers/index",
  more: "/pages/more/index",
  quote: "/pages/quote/index",
  customer: "/pages/customer/index",
} as const;

export function goTab(page: (typeof ROUTES)[keyof typeof ROUTES]): void {
  void Taro.switchTab({ url: page });
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

export function back(): void {
  void Taro.navigateBack();
}
