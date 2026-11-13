import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema";
import type { Db } from "./client";

/**
 * 存量演示数据的归属租户；新建库由迁移直接插入这条记录。
 * 新业务数据不允许依赖它——所有写入都必须显式提供 tenantId。
 */
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/** RLS 依赖的会话变量名。策略统一读取 `current_setting('app.tenant_id')`。 */
export const TENANT_SETTING = "app.tenant_id";

export interface TenantSession {
  readonly db: Db;
  readonly tenantId: string;
  /** 归还连接前重置租户变量，避免连接被复用时串租户。 */
  release(): Promise<void>;
}

/**
 * 为一个请求打开**独占连接**并把 `app.tenant_id` 设到会话级。
 *
 * 为什么是独占连接而不是事务级：内核服务内部会自行开事务（drizzle transaction），
 * `SET LOCAL` 在事务外不可见；会话级设置对同一连接上的后续事务全部生效。
 * 代价是一条请求占用一个连接，P0 的并发量下可接受，且换来了「无法忘记设租户」。
 */
export async function openTenantSession(pool: Pool, tenantId: string): Promise<TenantSession> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config($1, $2, false)", [TENANT_SETTING, tenantId]);
  } catch (error) {
    client.release();
    throw error;
  }

  return {
    db: drizzle(client, { schema }),
    tenantId,
    async release() {
      try {
        await client.query("RESET app.tenant_id");
      } finally {
        client.release();
      }
    },
  };
}

/** 便捷作用域封装：保证异常路径也会归还连接。 */
export async function withTenantSession<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const session = await openTenantSession(pool, tenantId);
  try {
    return await fn(session.db);
  } finally {
    await session.release();
  }
}
