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
