import { isProductionLike } from "@weave-order/schema";

/**
 * 工作台的服务端生产态判定。
 *
 * 实现只有一份：`@weave-order/schema` 的 `isProductionLike()`，与 apps/api 共用。
 * 服务端（route handler / server component / middleware）直接调用即可，
 * `NODE_ENV` 与 `AUTH_MODE` 都在运行时读取。
 *
 * 客户端组件不要直接调它：客户端包里 `NODE_ENV` 是构建期常量，
 * `AUTH_MODE` 则完全不可见。浏览器侧请用 `isProductionLikeInBrowser()`。
 */
export { isProductionLike };

/**
 * 浏览器侧的生产态判定。
 *
 * `/config.js`（运行时路由）由服务端用同一个 `isProductionLike()` 现算后下发，
 * 因此 `NODE_ENV=development + AUTH_MODE=oidc`（staging）在浏览器里也判为生产态，
 * 不会因为客户端包里的 `NODE_ENV=development` 而放开演示模式。
 *
 * 配置还没到（首帧）时按构建期 `NODE_ENV` 兜底：生产镜像里它已被内联为 production。
 */
export function isProductionLikeInBrowser(): boolean {
  if (typeof window === "undefined") return isProductionLike();
  const fromServer = window.__WEAVE_CONFIG__?.productionLike;
  if (typeof fromServer === "boolean") return fromServer;
  return process.env.NODE_ENV === "production";
}
