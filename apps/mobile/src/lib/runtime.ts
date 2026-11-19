import Taro from "@tarojs/taro";
import { createOfflineQueue } from "@weave-order/core";
import type { FlushResult } from "@weave-order/core";
import { createMobileApi } from "./mobile-api";
import type { MobileApi } from "./mobile-api";
import type { MockServer } from "./mock/server";
import {
  createMediaStore,
  createQueueStorage,
  flushQueue,
  getActiveTenant,
  setActiveTenant,
} from "./offline";
import type { QueuedMediaStore } from "./offline";
import { onUnauthorized, runtimeConfig } from "./oidc";
import { getAuthToken } from "./session";
import { createTaroFetch } from "./taro-fetch";
import type { MinimalFetch } from "./taro-fetch";

/**
 * 移动端运行时装配（唯一组合根）。
 *
 * - 页面只 import `api` / `offlineQueue`，不各自建 fetch；
 * - `TARO_ENV` 只在这里做端差异分支，页面里禁止复制三份实现；
 * - mock 与真后端共用同一套 Zod 契约，切换只改环境变量。
 */

export const TARO_ENV = process.env.TARO_ENV;
export const IS_H5 = TARO_ENV === "h5";
export const IS_WEAPP = TARO_ENV === "weapp";
export const IS_RN = TARO_ENV === "rn";
/** 构建期注入的版本号；本地开发没有 tag 时显示「开发版」。 */
export const APP_VERSION = process.env.TARO_APP_VERSION?.trim() || "开发版";
/**
 * mock 是演示/开发专用，生产构建下必须编译期关闭。
 *
 * 两个条件都是构建期常量（见 `config/index.ts` 的 defineConstants），
 * 所以 `TARO_APP_MOCK` 被误带到生产环境时也只是 `"1" === "1" && false`，
 * webpack 会把这个分支连同 mock 模块一起从产物里摘掉；
 * `scripts/check-prod-bundle.mjs` 在 `pnpm build` 末尾断言产物中不含 mock 代码。
 */
export const IS_MOCK = process.env.TARO_APP_MOCK === "1" && process.env.NODE_ENV !== "production";
/**
 * 托管层运行时注入优先，构建期常量只作小程序 / RN / 本地开发的回落。
 * 换 API 域名不用重发镜像（见 scripts/serve-static.mjs --runtime-config）。
 */
export const API_BASE_URL =
  runtimeConfig().apiBase || process.env.TARO_APP_API_BASE || "http://localhost:3000";

// 令牌持久化在 sessionStorage（session.ts），跨回调页导航与刷新都可用。
export { getAuthToken, setAuthToken, TOKEN_KEY } from "./session";

function readPreference(key: string): string | null {
  try {
    const value: unknown = Taro.getStorageSync(key);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string | null): void {
  try {
    if (value === null) Taro.removeStorageSync(key);
    else Taro.setStorageSync(key, value);
  } catch {
    // 隐私模式 / 存储配额满时不阻断页面。
  }
}

/** 非敏感偏好（角色、阈值、演示开关）才允许落本地。 */
export const prefs = {
  getRole(): string | null {
    return readPreference("weave.role");
  },
  setRole(role: string): void {
    writePreference("weave.role", role);
  },
  getLargeApprovalThresholdCents(): number {
    const raw = readPreference("weave.approval.threshold");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000_000;
  },
  setLargeApprovalThresholdCents(cents: number): void {
    writePreference("weave.approval.threshold", String(cents));
  },
  takeCameraMode(): string | null {
    const value = readPreference("weave.camera.mode");
    writePreference("weave.camera.mode", null);
    return value;
  },
  setCameraMode(mode: string): void {
    writePreference("weave.camera.mode", mode);
  },
  /**
   * 报价是 tab 页，`switchTab` 不能带 query：入口参数先落本地，报价页取一次即清。
   * 存取的都是未校验的 JSON —— 调用方（routes.ts）负责过 Zod。
   */
  takeQuoteEntry(): unknown {
    const raw = readPreference("weave.quote.entry");
    writePreference("weave.quote.entry", null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  },
  setQuoteEntry(entry: unknown): void {
    try {
      writePreference("weave.quote.entry", JSON.stringify(entry));
    } catch {
      // 不可序列化的参数不写：入口退回默认报价页。
    }
  },
};

/**
 * 用 `require` 而不是顶层 `import`，并且把条件写成字面量：
 * DefinePlugin 替换后 webpack 能静态判定 `if (false)`，整个分支连同
 * mock 服务端/种子数据一起从产物里摘掉。用变量（如 `IS_MOCK`）则不行 ——
 * webpack 在模块图阶段不会追踪变量的常量值，mock 仍会被打进 bundle。
 */
let mockServer: MockServer | null = null;
if (process.env.TARO_APP_MOCK === "1" && process.env.NODE_ENV !== "production") {
  const MOCK_STATE_KEY = "weave.mock.state";
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 必须用 require 才能让 webpack 静态摘除 mock 分支
  const { createMockServer } = require("./mock/server") as typeof import("./mock/server");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
  const { createStringMockStorage } = require("./mock/storage") as typeof import("./mock/storage");
  mockServer = createMockServer({
    storage: createStringMockStorage(
      () => readPreference(MOCK_STATE_KEY),
      (value) => writePreference(MOCK_STATE_KEY, value),
    ),
  });
}

const domFetch: MinimalFetch = async (input, init) => {
  const response = await fetch(input, init);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};

const remoteFetch: MinimalFetch = IS_H5 || IS_RN ? domFetch : createTaroFetch();

/**
 * 业务请求 401 统一回登录；mock 演示模式不走这层包装。
 *
 * 记录发请求时的令牌：只有「确实带了令牌」的 401 才算会话失效。
 * 启动早期未带令牌的 401（页面查询先于登录就绪）不得触发全局登出，
 * 否则会形成「401 → 跳 SSO → 回调 → 再 401」死循环。
 */
const authorizedFetch: MinimalFetch = async (input, init) => {
  const sentToken = getAuthToken();
  const response = await remoteFetch(input, init);
  if (response.status === 401) onUnauthorized(sentToken);
  return response;
};

const fetchImpl = mockServer ? mockServer.fetch : authorizedFetch;

export const api: MobileApi = createMobileApi(API_BASE_URL, fetchImpl, getAuthToken);

export const mediaStore: QueuedMediaStore = createMediaStore();

export const offlineQueue = createOfflineQueue(createQueueStorage());

export const queueDeps = { api, media: mediaStore };

/**
 * 从网关取「我在哪家公司」，并写进离线队列的作用域。
 * 多租户账号还没选租户时置空：此时不提交任何队列条目。
 */
export async function loadTenantContext(): Promise<void> {
  try {
    const me = await api.me();
    setActiveTenant("tenants" in me ? null : me.tenant.id);
  } catch {
    setActiveTenant(null);
  }
}

/** 恢复联网 / 启动时按时间序提交；冲突不自动覆盖。 */
export async function syncQueue(): Promise<FlushResult> {
  if (!getActiveTenant()) await loadTenantContext();
  const result = await flushQueue(offlineQueue, queueDeps);
  return result;
}

export function mockControls() {
  return mockServer;
}
