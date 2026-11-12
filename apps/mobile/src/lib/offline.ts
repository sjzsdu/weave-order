import Taro from "@tarojs/taro";
import { ApiError, isVersionConflict } from "@weave-order/core";
import type {
  ApprovalDecisionInput,
  CreateRevisionRequestInput,
  T004GenerateQuoteDraftInput,
} from "@weave-order/schema";
import type { FlushResult, OfflineQueue, QueueStorage, QueuedOperation } from "@weave-order/core";
import type { MobileApi, ProofInput } from "./mobile-api";

/**
 * 离线队列的端侧装配。
 *
 * - H5：IndexedDB（容量大、可存 Blob 引用）；
 * - 小程序 / App：Taro.setStorage；
 * - 提交严格按入队时间序；版本冲突不静默覆盖，标记后等人确认。
 */

const QUEUE_KEY = "weave.offline.queue";
const DB_NAME = "weave-offline";
const DB_STORE = "kv";

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
}

async function idbGet<T>(name: string, store: string, key: string): Promise<T | null> {
  const db = await openDb(name, store);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 读取失败"));
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(name: string, store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb(name, store);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 写入失败"));
  });
}

async function idbDelete(name: string, store: string, key: string): Promise<void> {
  const db = await openDb(name, store);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 删除失败"));
  });
}

function taroQueueStorage(): QueueStorage {
  return {
    load() {
      try {
        const value: unknown = Taro.getStorageSync(QUEUE_KEY);
        return Promise.resolve(Array.isArray(value) ? (value as QueuedOperation[]) : []);
      } catch {
        return Promise.resolve([]);
      }
    },
    save(items) {
      Taro.setStorageSync(QUEUE_KEY, items);
      return Promise.resolve();
    },
  };
}

export function createQueueStorage(): QueueStorage {
  if (!hasIndexedDb()) return taroQueueStorage();
  return {
    async load() {
      try {
        return (await idbGet<QueuedOperation[]>(DB_NAME, DB_STORE, QUEUE_KEY)) ?? [];
      } catch {
        return taroQueueStorage().load();
      }
    },
    async save(items) {
      try {
        await idbPut(DB_NAME, DB_STORE, QUEUE_KEY, items);
      } catch {
        await taroQueueStorage().save(items);
      }
    },
  };
}

const listeners = new Set<() => void>();

export function onQueueChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyQueueChanged(): void {
  for (const listener of listeners) listener();
}

export interface QueuedMediaStore {
  put(key: string, value: Blob | string): Promise<void>;
  get(key: string): Promise<Blob | string | null>;
}

/** 离线照片：H5 存 Blob 到 IndexedDB；小程序把临时文件转存为持久路径。 */
export function createMediaStore(): QueuedMediaStore {
  const mediaKey = (key: string) => `weave.media.${key}`;
  if (!hasIndexedDb()) {
    return {
      async put(key, value) {
        if (typeof value !== "string") throw new Error("小程序端只接受本地文件路径");
        if (typeof Taro.saveFile !== "function") {
          Taro.setStorageSync(mediaKey(key), value);
          return;
        }
        const saved = await Taro.saveFile({ tempFilePath: value });
        if ("savedFilePath" in saved) Taro.setStorageSync(mediaKey(key), saved.savedFilePath);
      },
      get(key) {
        const path: unknown = Taro.getStorageSync(mediaKey(key));
        return Promise.resolve(typeof path === "string" ? path : null);
      },
    };
  }
  return {
    async put(key, value) {
      await idbPut("weave-media", "media", key, value);
    },
    async get(key) {
      return idbGet<Blob | string>("weave-media", "media", key);
    },
  };
}

/** 冲突运行时带上服务端版本 / 快照，供人工取舍。 */
function attachConflict(op: QueuedOperation, error: unknown): void {
  if (!isVersionConflict(error) || !(error instanceof ApiError)) return;
  const details = error.details as
    { details?: { serverVersion?: number; serverSnapshot?: unknown } } | undefined;
  const serverVersion = details?.details?.serverVersion;
  if (typeof serverVersion === "number") {
    op.serverVersion = serverVersion;
    op.serverSnapshot = details?.details?.serverSnapshot;
  }
}

export interface QueueDeps {
  api: MobileApi;
  media: QueuedMediaStore;
}

async function uploadQueuedMedia(mediaKey: string, deps: QueueDeps): Promise<string> {
  const stored = await deps.media.get(mediaKey);
  if (!stored) throw new Error("离线照片已丢失，请重拍");
  const { uploadStoredMedia } = await import("./media");
  return uploadStoredMedia(stored, deps.api);
}

/**
 * 一个队列操作 → 一个契约调用。
 * 注意：分享链接不排队（链接必须由服务端签发，离线时只提示联网后再试）。
 */
export async function submitQueuedOperation(op: QueuedOperation, deps: QueueDeps): Promise<void> {
  const payload = op.payload as Record<string, unknown>;
  try {
    switch (op.kind) {
      case "quote.compose": {
        const result = await deps.api.generateQuoteDraft(payload as T004GenerateQuoteDraftInput);
        if (!result.ok)
          throw new ApiError(400, result.error.code, result.error.message, result.error);
        return;
      }
      case "quote.revise": {
        const revision = await deps.api.createRevision(payload as CreateRevisionRequestInput);
        await deps.api.decideRevision({
          revisionRequestId: revision.id,
          decision: "APPROVE",
          note: "移动端离线改价，恢复后人工确认",
        });
        return;
      }
      case "quote.decide": {
        const result = await deps.api.decideApproval(payload as unknown as ApprovalDecisionInput);
        if (!result.ok)
          throw new ApiError(400, result.error.code, result.error.message, result.error);
        return;
      }
      case "shipment.proof": {
        const mediaKey = typeof payload.mediaKey === "string" ? payload.mediaKey : "";
        const imageUrl = await uploadQueuedMedia(mediaKey, deps);
        const proof: ProofInput = {
          kind: (payload.kind as ProofInput["kind"] | undefined) ?? "SIGNATURE",
          imageUrl,
          ...(typeof payload.trackingNumber === "string"
            ? { trackingNumber: payload.trackingNumber }
            : {}),
          ...(typeof payload.note === "string" ? { note: payload.note } : {}),
        };
        await deps.api.recordProof(proof);
        return;
      }
      default:
        throw new Error(`未知的离线操作：${op.kind}`);
    }
  } catch (error) {
    attachConflict(op, error);
    throw error;
  }
}

export async function flushQueue(queue: OfflineQueue, deps: QueueDeps): Promise<FlushResult> {
  const result = await queue.flush({
    submit: (op) => submitQueuedOperation(op, deps),
    isConflict: isVersionConflict,
  });
  if (result.sent > 0 || result.conflicts > 0 || result.failed > 0) notifyQueueChanged();
  return result;
}

export async function enqueueOperation(
  queue: OfflineQueue,
  op: {
    kind: string;
    payload: unknown;
    baseVersion?: number;
    opId: string;
  },
): Promise<QueuedOperation> {
  const created = await queue.enqueue(op);
  notifyQueueChanged();
  return created;
}

export { openDb, idbGet, idbDelete };
