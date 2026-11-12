import Taro from "@tarojs/taro";
import { createApiClient } from "@weave-order/core";
import { createOfflineQueue } from "@weave-order/core";
import type { ApiClient, QueueStorage, QueuedOperation } from "@weave-order/core";

const TOKEN_KEY = "weave.auth.token";
const QUEUE_KEY = "weave.offline.queue";
const API_BASE = process.env.TARO_APP_API_BASE ?? "http://localhost:3000";

/**
 * 端侧适配：H5 与小程序的存储 API 由 Taro 抹平。
 * token 不落明文到日志；离线操作只存业务 payload，不存成本/毛利。
 */
export const storage = {
  async getToken(): Promise<string | null> {
    try {
      const value = await Taro.getStorage({ key: TOKEN_KEY });
      return typeof value.data === "string" ? value.data : null;
    } catch {
      return null;
    }
  },
  async setToken(token: string | null): Promise<void> {
    if (token === null) await Taro.removeStorage({ key: TOKEN_KEY });
    else await Taro.setStorage({ key: TOKEN_KEY, data: token });
  },
};

const taroQueueStorage: QueueStorage = {
  async load(): Promise<QueuedOperation[]> {
    try {
      const value = await Taro.getStorage({ key: QUEUE_KEY });
      return Array.isArray(value.data) ? (value.data as QueuedOperation[]) : [];
    } catch {
      return [];
    }
  },
  async save(items: QueuedOperation[]): Promise<void> {
    await Taro.setStorage({ key: QUEUE_KEY, data: items });
  },
};

export const offlineQueue = createOfflineQueue(taroQueueStorage);

export const api: ApiClient = createApiClient({
  baseUrl: API_BASE,
  getToken: () => storage.getToken(),
});

/** 移动端只复用 tokens 数值；组件用 Taro 原生组件。 */
export const API_BASE_URL = API_BASE;
