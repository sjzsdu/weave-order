import path from "node:path";

/**
 * E2E 运行参数的唯一来源。
 *
 * 默认端口刻意避开日常开发（API 3000 / Web 3001），这样 `pnpm e2e` 可以和
 * `pnpm dev` 同时跑，不会把别人正在看的服务重启掉。
 */
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:3100";
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3101";
export const MOBILE_URL = process.env.E2E_MOBILE_URL ?? "http://localhost:3102";

/** 对象存储的公开读地址（缩略图断言要用它识别图片请求）。 */
export const MEDIA_BASE_URL = process.env.E2E_MEDIA_BASE_URL ?? "http://127.0.0.1:9000/weave-media";

export const AUTH = {
  owner: process.env.E2E_AUTH_TOKEN ?? "dev:demo:demo",
  sales: process.env.E2E_SALES_TOKEN ?? "dev:demo-sales:demo",
} as const;

export const API_PORT = new URL(API_URL).port || "3100";
export const WEB_PORT = new URL(WEB_URL).port || "3101";
export const MOBILE_PORT = new URL(MOBILE_URL).port || "3102";

/** 本仓库根目录（specs 在 <root>/e2e/specs）。 */
export const E2E_DIR = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(E2E_DIR, "..");
export const ARTIFACTS_DIR = path.resolve(E2E_DIR, ".artifacts");
