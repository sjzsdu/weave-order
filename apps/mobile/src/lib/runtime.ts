import Taro from "@tarojs/taro";
import { createOfflineQueue } from "@weave-order/core";
import type { FlushResult } from "@weave-order/core";
import { createMobileApi } from "./mobile-api";
import type { MobileApi } from "./mobile-api";
import { createMockServer } from "./mock/server";
import { createStringMockStorage } from "./mock/storage";
import { createMediaStore, createQueueStorage, flushQueue } from "./offline";
import type { QueuedMediaStore } from "./offline";
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
export const IS_MOCK = process.env.TARO_APP_MOCK === "1";
export const API_BASE_URL = process.env.TARO_APP_API_BASE ?? "http://localhost:3000";

const TOKEN_KEY = "weave.session.token";
const MOCK_STATE_KEY = "weave.mock.state";

/**
 * 令牌只驻留内存，不落本地明文；页面刷新 / 冷启动重新走 OIDC 登录。
 * 这是「不落明文 token」的硬约束，不能用「加密存储」打折扣。
 */
let memoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

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
};

const mockServer = IS_MOCK
  ? createMockServer({
      storage: createStringMockStorage(
        () => readPreference(MOCK_STATE_KEY),
        (value) => writePreference(MOCK_STATE_KEY, value),
      ),
    })
  : null;

const domFetch: MinimalFetch = async (input, init) => {
  const response = await fetch(input, init);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};

const remoteFetch: MinimalFetch = IS_H5 || IS_RN ? domFetch : createTaroFetch();

const fetchImpl = mockServer ? mockServer.fetch : remoteFetch;

export const api: MobileApi = createMobileApi(API_BASE_URL, fetchImpl, () => memoryToken);

export const mediaStore: QueuedMediaStore = createMediaStore();

export const offlineQueue = createOfflineQueue(createQueueStorage());

export const queueDeps = { api, media: mediaStore };

/** 恢复联网 / 启动时按时间序提交；冲突不自动覆盖。 */
export async function syncQueue(): Promise<FlushResult> {
  const result = await flushQueue(offlineQueue, queueDeps);
  return result;
}

export function mockControls() {
  return mockServer;
}

export { TOKEN_KEY };
