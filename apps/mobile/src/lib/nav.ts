import { enterCamera as enterCameraRoute, parseCameraMode } from "../routes";

/**
 * 导航兼容层（仅为历史 import 保留）。
 *
 * 实现在 `src/routes.ts`：路由表、tab 标记、入口参数都在那里。
 * 新代码请直接 `import ... from "../routes"`，这里只是转发，避免一次性改几十处 import。
 */
export {
  ROUTES,
  ROUTE_PATHS,
  TAB_ROUTES,
  back,
  consumeQuoteEntry,
  enterCamera,
  enterQuote,
  goTab,
  isTabPath,
  openApprovals,
  openCustomer,
  openStart,
  openWorkspace,
  parseCameraMode,
  takeQuoteEntry,
} from "../routes";
export type {
  CameraEntryParams,
  CameraMode,
  QuoteEntryParams,
  QuoteMode,
  RouteName,
  RoutePath,
  TabPath,
} from "../routes";

/** 兼容旧调用名：报价入口只有 `enterQuote` 一份实现。 */
export { enterQuote as openQuote } from "../routes";

/** @deprecated 用 `enterCamera({ mode })`：相机不是 tab 了，要带参数打开。 */
export function openCamera(mode: string): void {
  const parsed = parseCameraMode(mode);
  if (!parsed) {
    console.error(`[nav] 未知的相机模式：${mode}`);
    return;
  }
  enterCameraRoute({ mode: parsed });
}
