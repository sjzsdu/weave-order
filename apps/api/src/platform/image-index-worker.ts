import type { Pool } from "pg";
import { withTenantSession } from "@weave-order/db";
import type { ImageEmbeddingProvider } from "./embedding";
import type { ObjectStorage } from "./storage";
import { ImageIndexService } from "../kernel/image-index.service";

export interface ImageIndexJob {
  tenantId: string;
  /** 单张图：挂图 / 建样品时入队。 */
  imageId?: string;
  /** 一个样品下的全部缺图：改图组时入队。 */
  sampleId?: string;
  /** 租户级补齐：找样时发现还有没索引的图，顺带修一次。 */
  sweep?: boolean;
}

export interface ImageIndexWorkerOptions {
  /** 同一时刻最多跑几个 embedding 请求（模型侧限流，别把自己打成 DoS）。 */
  concurrency?: number;
  /** 单租户「补漏」的最小间隔，避免每次搜索都触发一次扫描。 */
  sweepCooldownMs?: number;
  /** 送模型前的缩图长边（与内核配置保持一致；0 = 关闭）。 */
  maxEdge?: number;
  logger?: (message: string) => void;
}

let activeWorker: ImageIndexWorker | null = null;

/** 进程级单例：`createKernel` 在 HTTP 路径上取它，CLI / 单测拿到 null 时退回同步索引。 */
export function setImageIndexWorker(worker: ImageIndexWorker | null): void {
  activeWorker = worker;
}

export function getImageIndexWorker(): ImageIndexWorker | null {
  return activeWorker;
}

/**
 * 图像索引后台工作者。
 *
 * 为什么不是「请求里 await」：挂图后算向量要调外部模型（缩图后 ~200ms，模型抖动时更久），
 * 把这条链路绑进 HTTP 响应会让「上传转圈」。所以 confirm 只写 `pending` 并立即返回，
 * 由这里在后台算完再置 `ready/failed`。
 *
 * 为什么是「进程内队列 + 读路径补漏」而不是 Redis 队列：
 * - 数据库本身就是队列（`sample_images.index_status`），Redis 只是加速派发；
 * - 进程崩了不会丢任务：行还是 `pending`，下次该租户任何一次找样都会触发一次补漏；
 * - 不需要额外运维一个 broker，也不需要处理多实例抢锁。
 * 需要「跨实例秒级派发」时再上 Redis（P1），接口不用改。
 */
export class ImageIndexWorker {
  private readonly queue: ImageIndexJob[] = [];
  private readonly inFlight = new Set<string>();
  private readonly lastSweepAt = new Map<string, number>();
  private readonly concurrency: number;
  private readonly sweepCooldownMs: number;
  private readonly logger: (message: string) => void;
  /** 当前正在跑的 pump（drain/stop 要等它，否则会「队列空了但任务还没跑完」）。 */
  private pumpPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly embedder: ImageEmbeddingProvider,
    private readonly storage: ObjectStorage | null,
    private readonly options: ImageIndexWorkerOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.sweepCooldownMs = Math.max(0, options.sweepCooldownMs ?? 60_000);
    this.logger = options.logger ?? (() => undefined);
  }

  /** 入队单张图。同一张图重复入队会被合并（`inFlight` + 队列去重）。 */
  enqueueImage(tenantId: string, imageId: string): void {
    this.push({ tenantId, imageId });
  }

  /** 入队一个样品下所有缺图（改图组 / 建样品）。 */
  enqueueSample(tenantId: string, sampleId: string): void {
    this.push({ tenantId, sampleId });
  }

  /** 找样时发现还有没索引的图：按租户节流地补一次。 */
  requestTenantSweep(tenantId: string): void {
    const now = Date.now();
    const last = this.lastSweepAt.get(tenantId) ?? 0;
    if (now - last < this.sweepCooldownMs) return;
    this.lastSweepAt.set(tenantId, now);
    this.push({ tenantId, sweep: true });
  }

  /** 队列里还有多少待处理任务（测试 / 健康检查用）。 */
  get pendingJobs(): number {
    return this.queue.length;
  }

  /**
   * 把队列表跑干净。返回本次处理的任务数。
   * 生产不需要显式调用（入队即自动 pump）；测试用它拿到确定性时序。
   */
  async drain(): Promise<number> {
    let processed = 0;
    // 先等已经在跑的 pump 收尾（入队即自动 pump，drain 不能只看队列长度）。
    while (this.pumpPromise || this.queue.length > 0) {
      if (this.pumpPromise) {
        await this.pumpPromise;
        continue;
      }
      processed += await this.runBatch();
    }
    return processed;
  }

  private async runBatch(): Promise<number> {
    const batch = this.queue.splice(0, this.concurrency);
    if (batch.length === 0) return 0;
    await Promise.all(batch.map((job) => this.runJob(job)));
    return batch.length;
  }

  /** 应用关闭时尽力跑完队列（超时即放弃，剩下的行仍是 pending，下次补漏）。 */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopped = true;
    await Promise.race([
      this.drain(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (activeWorker === this) setImageIndexWorker(null);
  }

  private push(job: ImageIndexJob): void {
    if (this.stopped) return;
    if (job.imageId && this.inFlight.has(job.imageId)) return;
    if (job.imageId) this.inFlight.add(job.imageId);
    this.queue.push(job);
    void this.pump();
  }

  /** 入队即自动开跑；同一时刻只有一个 pump。 */
  private pump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = (async () => {
      try {
        while (this.queue.length > 0) await this.runBatch();
      } finally {
        this.pumpPromise = null;
      }
    })();
    return this.pumpPromise;
  }

  private async runJob(job: ImageIndexJob): Promise<void> {
    try {
      await withTenantSession(this.pool, job.tenantId, async (db) => {
        const index = new ImageIndexService(db, this.embedder, job.tenantId, this.storage, {
          maxEdge: this.options.maxEdge,
        });
        if (job.imageId) {
          await index.indexImage(job.imageId);
          return;
        }
        if (job.sampleId) {
          await index.ensureSampleIndexed(job.sampleId);
          return;
        }
        // 补漏：只处理本租户缺向量 / 失败的图，单批有上限，避免一次扫全表。
        const ids = await index.pendingImageIds(50);
        for (const imageId of ids) {
          try {
            await index.indexImage(imageId);
          } catch {
            // 单张失败已写入 index_status=failed，下一轮再试。
          }
        }
      });
    } catch (error) {
      this.logger(
        `图像索引任务失败（tenant=${job.tenantId} image=${job.imageId ?? "-"} sample=${job.sampleId ?? "-"}）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (job.imageId) this.inFlight.delete(job.imageId);
    }
  }
}
