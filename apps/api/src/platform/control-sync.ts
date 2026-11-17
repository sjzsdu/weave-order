import { and, asc, eq, lte, or } from "drizzle-orm";
import { controlSyncOutbox } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { NewControlSyncOutboxRow } from "@weave-order/db";

/**
 * 控制面登记的可靠投递（Transactional Outbox 的消费端）。
 *
 * 租户创建时已在业务库同事务写入 outbox 行（见 tenancy.service.createTenant）。
 * 这里扫 pending 行投递到控制面内部接口，失败指数退避，超过阈值转 dead 并告警。
 *
 * 设计成分层：
 * - OutboxStore 窄接口 = DB 访问，便于单测用内存实现；
 * - runControlSyncOnce = 纯状态机，不碰 DB/网络，直接单测；
 * - createDrizzleOutboxStore = 真实 store（owner 连接，无租户 RLS）。
 */

export type OutboxStatus = "pending" | "synced" | "failed" | "dead";

export interface OutboxJob {
  id: string;
  slug: string;
  name: string;
  ownerEmail: string | null;
  attempts: number;
}

export interface OutboxStore {
  /** 取出到期需投递的 pending 行（含 attempts 未超阈值的 failed 行，按 next_attempt_at 升序）。 */
  claimDue(now: Date, limit: number): Promise<OutboxJob[]>;
  markSynced(id: string, now: Date): Promise<void>;
  markFailed(
    id: string,
    patch: { attempts: number; nextAttemptAt: Date; lastError: string; status: OutboxStatus },
  ): Promise<void>;
  insert(row: NewControlSyncOutboxRow): Promise<void>;
}

/** 投递函数：成功返回 void，失败抛错。 */
export type Deliver = (job: OutboxJob) => Promise<void>;

export interface SyncResult {
  attempted: number;
  synced: number;
  failed: number;
  dead: number;
}

export interface SyncOptions {
  maxAttempts?: number;
  /** 退避基数（毫秒）：attempt=1 → base，2 → base*5，3 → base*25。 */
  backoffBaseMs?: number;
  now?: () => Date;
  onDead?: (job: OutboxJob, error: unknown) => void;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_BASE_MS = 60_000;

/**
 * 跑一轮投递。逐条处理，单条失败不影响其余行；返回的计数可直接打日志/告警。
 */
export async function runControlSyncOnce(
  store: OutboxStore,
  deliver: Deliver,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const now = () => options.now?.() ?? new Date();
  const result: SyncResult = { attempted: 0, synced: 0, failed: 0, dead: 0 };

  const jobs = await store.claimDue(now(), 50);
  for (const job of jobs) {
    result.attempted += 1;
    try {
      await deliver(job);
      await store.markSynced(job.id, now());
      result.synced += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const status: OutboxStatus = attempts >= maxAttempts ? "dead" : "failed";
      const nextAttemptAt = new Date(now().getTime() + backoffBase * 5 ** (attempts - 1));
      const lastError = error instanceof Error ? error.message : String(error);
      await store.markFailed(job.id, { attempts, nextAttemptAt, lastError, status });
      if (status === "dead") {
        result.dead += 1;
        options.onDead?.(job, error);
      } else {
        result.failed += 1;
      }
    }
  }
  return result;
}

/** 真实 store：用 owner 连接，outbox 是平台级表，不在租户 RLS 清单内。 */
export function createDrizzleOutboxStore(db: Db): OutboxStore {
  return {
    async claimDue(now, limit) {
      const rows = await db
        .select()
        .from(controlSyncOutbox)
        .where(
          and(
            or(eq(controlSyncOutbox.status, "pending"), eq(controlSyncOutbox.status, "failed")),
            lte(controlSyncOutbox.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(controlSyncOutbox.nextAttemptAt))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        ownerEmail: row.ownerEmail,
        attempts: row.attempts,
      }));
    },
    async markSynced(id, now) {
      await db
        .update(controlSyncOutbox)
        .set({ status: "synced", syncedAt: now, lastError: null })
        .where(eq(controlSyncOutbox.id, id));
    },
    async markFailed(id, patch) {
      await db
        .update(controlSyncOutbox)
        .set({
          attempts: patch.attempts,
          nextAttemptAt: patch.nextAttemptAt,
          lastError: patch.lastError.slice(0, 2000),
          status: patch.status,
        })
        .where(eq(controlSyncOutbox.id, id));
    },
    async insert(row) {
      await db.insert(controlSyncOutbox).values(row);
    },
  };
}

/** 调用 platform-api 内部登记接口的投递实现（服务进程对服务进程，共享密钥）。 */
export function createHttpDeliver(options: {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Deliver {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  return async (job) => {
    const response = await doFetch(`${base}/platform/api/internal/tenants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-weave-internal": options.secret,
      },
      body: JSON.stringify({ slug: job.slug, name: job.name, ownerEmail: job.ownerEmail }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
    if (!response.ok) {
      throw new Error(`控制面登记返回 ${response.status}`);
    }
  };
}
