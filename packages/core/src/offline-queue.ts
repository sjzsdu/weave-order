/**
 * 离线队列（H5 = IndexedDB / 小程序 = Taro.setStorage）。
 *
 * 设计原则：
 * - 每个操作有客户端 `opId`，服务端按幂等键去重；
 * - 按入队时间顺序提交，冲突不静默覆盖：留在队列并标记 `conflict`，
 *   由人类在「服务端版本 + 人工确认」后决定；
 * - 本模块不依赖具体存储与网络，端侧注入 adapter。
 */

export type QueueStatus = "pending" | "conflict";

export interface QueuedOperation {
  opId: string;
  /** 例如 "revision.request" / "quote.decide" */
  kind: string;
  payload: unknown;
  /** 基线版本，用于服务端并发检测。 */
  baseVersion?: number;
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export interface QueueStorage {
  load(): Promise<QueuedOperation[]>;
  save(items: QueuedOperation[]): Promise<void>;
}

export interface FlushResult {
  sent: number;
  conflicts: number;
  failed: number;
}

export interface FlushOptions {
  submit: (op: QueuedOperation) => Promise<void>;
  /** 判断错误是否属于版本冲突。 */
  isConflict?: (error: unknown) => boolean;
  now?: () => Date;
}

export function memoryStorage(seed: QueuedOperation[] = []): QueueStorage {
  let items = [...seed];
  return {
    load() {
      return Promise.resolve(items.map((item) => ({ ...item })));
    },
    save(next) {
      items = next.map((item) => ({ ...item }));
      return Promise.resolve();
    },
  };
}

export function createOfflineQueue(storage: QueueStorage) {
  return {
    async list(): Promise<QueuedOperation[]> {
      return storage.load();
    },

    async enqueue(
      op: Omit<QueuedOperation, "status" | "attempts" | "createdAt"> & {
        createdAt?: string;
        now?: () => Date;
      },
    ): Promise<QueuedOperation> {
      const items = await storage.load();
      if (items.some((item) => item.opId === op.opId)) {
        const existing = items.find((item) => item.opId === op.opId);
        if (existing) return existing;
      }
      const created: QueuedOperation = {
        opId: op.opId,
        kind: op.kind,
        payload: op.payload,
        baseVersion: op.baseVersion,
        status: "pending",
        attempts: 0,
        createdAt: op.createdAt ?? (op.now ?? (() => new Date()))().toISOString(),
      };
      await storage.save([...items, created]);
      return created;
    },

    async remove(opId: string): Promise<void> {
      const items = await storage.load();
      await storage.save(items.filter((item) => item.opId !== opId));
    },

    /**
     * 顺序提交待发送操作。遇到失败即停止（保持时间序，避免后写的操作
     * 先于先写的生效）；冲突标记后继续处理后面的操作。
     */
    async flush(options: FlushOptions): Promise<FlushResult> {
      const items = await storage.load();
      const result: FlushResult = { sent: 0, conflicts: 0, failed: 0 };

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item) continue;
        if (item.status === "conflict") continue;
        try {
          await options.submit(item);
          result.sent += 1;
          items.splice(index, 1);
          index -= 1;
          await storage.save(items);
        } catch (error) {
          item.attempts += 1;
          item.lastError = error instanceof Error ? error.message : String(error);
          if (options.isConflict?.(error)) {
            item.status = "conflict";
            result.conflicts += 1;
            await storage.save(items);
            continue;
          }
          result.failed += 1;
          await storage.save(items);
          break;
        }
      }
      return result;
    },
  };
}

export type OfflineQueue = ReturnType<typeof createOfflineQueue>;
