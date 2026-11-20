import Taro from "@tarojs/taro";
import { ApiError, isVersionConflict } from "@weave-order/core";
import { statusForToolFailure } from "@weave-order/schema";
import type {
  ApprovalDecisionInput,
  CreateRevisionRequestInput,
  T004GenerateQuoteDraftInput,
  ToolError,
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

/**
 * 当前会话的租户。队列是设备级的，但每条操作都要带上自己的租户：
 * 否则在 A 公司排队的改价草稿，会在切到 B 公司、恢复联网时按 B 的会话提交。
 */
let activeTenantId: string | null = null;

export function setActiveTenant(tenantId: string | null): void {
  activeTenantId = tenantId;
}

export function getActiveTenant(): string | null {
  return activeTenantId;
}

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

/** 工具契约的失败 → ApiError：状态码沿用服务端映射，队列才认得出版本冲突。 */
function toApiError(error: ToolError): ApiError {
  return new ApiError(statusForToolFailure(error), error.code, error.message, error);
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
        if (!result.ok) throw toApiError(result.error);
        return;
      }
      case "quote.revise": {
        // 语义：离线时用户本人改自己的草稿 = 直接应用（产品设计 §7.8），
        // 不是「恢复联网后再找一个人审批」。approval 仍是单独的 quote.decide 操作。
        const revision = await deps.api.createRevision(payload as CreateRevisionRequestInput);
        await deps.api.decideRevision({
          revisionRequestId: revision.id,
          decision: "APPROVE",
          note: "离线改价，直接应用用户本人修改",
        });
        return;
      }
      case "quote.decide": {
        const result = await deps.api.decideApproval(payload as unknown as ApprovalDecisionInput);
        if (!result.ok) throw toApiError(result.error);
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
      case "inbound.submit": {
        const mediaKey = typeof payload.mediaKey === "string" ? payload.mediaKey : "";
        const stored = await deps.media.get(mediaKey);
        if (!stored) throw new Error("离线照片已丢失，请重拍");
        const { uploadStoredInboundMedia } = await import("./media");
        const uploaded = await uploadStoredInboundMedia(stored, deps.api);
        // 用 opId 作为 clientRequestId：补传重试不会产生第二条 inbound。
        await deps.api.submitInbound({
          ...(typeof payload.text === "string" && payload.text.trim()
            ? { text: payload.text }
            : {}),
          source: "mobile-camera",
          clientRequestId: op.opId,
          attachments: [
            {
              objectKey: uploaded.objectKey,
              mimeType: "image/jpeg",
              kind:
                payload.kind === "bizcard" || payload.kind === "label" || payload.kind === "fabric"
                  ? payload.kind
                  : "auto",
            },
          ],
        });
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
    // 没有当前租户时不加过滤（登录前的历史条目仍可提交）；
    // 有租户时严格只提交该租户的条目。
    ...(activeTenantId ? { tenantId: activeTenantId } : {}),
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
    /** 显式租户优先；缺省用当前会话租户。 */
    tenantId?: string;
  },
): Promise<QueuedOperation> {
  const created = await queue.enqueue({
    ...op,
    tenantId: op.tenantId ?? activeTenantId ?? undefined,
  });
  notifyQueueChanged();
  return created;
}

export { openDb, idbGet, idbDelete };
