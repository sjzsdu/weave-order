import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Client } from "pg";
import type { Pool } from "pg";

/**
 * LangGraph 的 PostgreSQL 检查点。
 *
 * 表结构由官方 saver 的 setup() 管理（checkpoints / checkpoint_blobs /
 * checkpoint_writes），与业务表的 Drizzle 迁移互不干扰。
 * setup() 幂等，可重复调用，但**不是并发安全的**：它先读迁移版本再逐条执行 DDL，
 * 并发首调会撞系统目录（duplicate key ... pg_type_typname_nsp_index）。
 *
 * 所以这里加两把锁：
 * - 进程内：`getPostgresCheckpointer` 让同一连接池的并发调用共享一个 promise；
 * - 进程间：setup() 期间持有 Postgres 咨询锁，多副本同时冷启动也只有一个在跑 DDL。
 */
const SETUP_LOCK_NAMESPACE = 7702;
const SETUP_LOCK_ID = 180;

async function withSetupLock<T>(pool: Pool, run: () => Promise<T>): Promise<T> {
  // 用独立连接持锁，而不是从业务连接池里借一条：
  // 否则高并发冷启动时所有连接都在等锁，持锁者自己反而借不到连接跑 setup()。
  const client = new Client(pool.options);
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [SETUP_LOCK_NAMESPACE, SETUP_LOCK_ID]);
    return await run();
  } finally {
    // 会话级咨询锁随连接结束释放；end() 失败也不影响这一点，不能掩盖 setup() 的错误。
    await client.end().catch(() => undefined);
  }
}

export async function createPostgresCheckpointer(pool: Pool): Promise<PostgresSaver> {
  const checkpointer = new PostgresSaver(pool);
  await withSetupLock(pool, () => checkpointer.setup());
  return checkpointer;
}

/**
 * 同一连接池只初始化一次检查点。
 *
 * 冷启动窗口里的并发请求拿到的是同一个 promise，而不是各自跑一遍 setup()
 * （WAN-180）。失败时清空缓存，让下一次请求可以重试 —— 一次 DDL 抖动不能
 * 把整个进程变成永久坏状态。
 */
export function createCheckpointerCache(
  factory: (pool: Pool) => Promise<PostgresSaver> = createPostgresCheckpointer,
): (pool: Pool) => Promise<PostgresSaver> {
  const pending = new WeakMap<Pool, Promise<PostgresSaver>>();
  return (pool) => {
    const cached = pending.get(pool);
    if (cached) return cached;
    const created = factory(pool).catch((error: unknown) => {
      pending.delete(pool);
      throw error;
    });
    pending.set(pool, created);
    return created;
  };
}

/** 进程级默认缓存：`DatabaseProvider` 只有一个连接池，等价于「每个进程初始化一次」。 */
export const getPostgresCheckpointer = createCheckpointerCache();
