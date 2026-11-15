import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import {
  API_PORT,
  API_URL,
  AUTH,
  MOBILE_PORT,
  MOBILE_URL,
  REPO_ROOT,
  WEB_PORT,
  WEB_URL,
} from "./support/env";

const configDir = __dirname;

/**
 * owner 的登录态：Web 的 BFF 只认 httpOnly Cookie，dev 模式下
 * `dev:demo:demo` 就是 OWNER；sales 用例会另开 context 换 token。
 */
const ownerState = {
  cookies: [
    {
      name: "weave_token",
      value: AUTH.owner,
      domain: "localhost",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
    },
  ],
  origins: [],
};

export default defineConfig({
  testDir: path.join(configDir, "specs"),
  outputDir: path.join(configDir, ".artifacts", "test-results"),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(configDir, ".artifacts", "report"), open: "never" }],
  ],
  globalSetup: path.join(configDir, "support", "global-setup.ts"),
  use: {
    baseURL: WEB_URL,
    storageState: ownerState,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --filter @weave-order/api exec tsx src/main.ts",
      cwd: REPO_ROOT,
      url: `${API_URL}/api/health`,
      reuseExistingServer: process.env.E2E_REUSE_SERVERS === "1",
      timeout: 120_000,
      // 显式继承 runner 环境（CI 的 DATABASE_URL / S3_* 等必须传进子进程）。
      env: {
        ...(process.env as Record<string, string>),
        PORT: API_PORT,
        NODE_ENV: "development",
        AUTH_MODE: "dev",
        // 走 CDN 直链形态，图墙「只请求缩略图」才可断言（?w=320）。
        MEDIA_BASE_URL: process.env.E2E_MEDIA_BASE_URL ?? "http://127.0.0.1:9000/weave-media",
      },
    },
    {
      command: `pnpm --filter @weave-order/web exec next start --port ${WEB_PORT}`,
      cwd: REPO_ROOT,
      url: `${WEB_URL}/login`,
      reuseExistingServer: process.env.E2E_REUSE_SERVERS === "1",
      timeout: 120_000,
      env: {
        ...(process.env as Record<string, string>),
        API_PROXY_TARGET: API_URL,
        WEB_APP_URL: WEB_URL,
        DEV_AUTH_TOKEN: AUTH.owner,
        // web 与 api 共用 isProductionLike()：显式给 dev，避免 CI 的 NODE_ENV=test
        // 被误当成生产态（那样连 dev 兜底和 /auth/dev 都会被关掉）。
        AUTH_MODE: "dev",
      },
    },
    {
      // --runtime-config 把 API base 注入 index.html：即使 dist 被其它命令
      // （pnpm lint / build）用默认 3000 重打包，H5 仍然打 E2E 的 3100。
      command: "node scripts/serve-static.mjs apps/mobile/dist --spa --healthz --runtime-config",
      cwd: REPO_ROOT,
      url: `${MOBILE_URL}/healthz`,
      reuseExistingServer: process.env.E2E_REUSE_SERVERS === "1",
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        PORT: MOBILE_PORT,
        WEAVE_API_BASE: API_URL,
      },
    },
  ],
  projects: [
    {
      name: "desktop-1280",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
      testMatch: /desktop\/.*\.spec\.ts/,
    },
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testMatch: /desktop\/(gallery-layout|media-status)\.spec\.ts/,
    },
    {
      name: "desktop-375",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
      testMatch: /desktop\/(gallery-layout|media-status)\.spec\.ts/,
    },
    {
      // 640~767 是「更多」与桌面入口最容易重叠的缝隙（WAN-131 review P2-1）。
      name: "desktop-700",
      use: { ...devices["Desktop Chrome"], viewport: { width: 700, height: 900 } },
      testMatch: /desktop\/gallery-layout\.spec\.ts/,
    },
    {
      name: "mobile-h5",
      use: {
        ...devices["Pixel 7"],
        baseURL: MOBILE_URL,
        // 移动端没有 BFF 登录态：令牌由 spec 在请求层注入，context 本身不带 cookie。
        storageState: { cookies: [], origins: [] },
        serviceWorkers: "block",
      },
      testMatch: /mobile\/.*\.spec\.ts/,
    },
  ],
});
