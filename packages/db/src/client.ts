import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * 连接池 + Drizzle 实例。
 *
 * 只允许 apps/api/src/kernel 与 packages/db 自身引用本模块；
 * apps/api/src/tools、agent、approval 由 ESLint 禁止 import（边界测试锁定）。
 */
export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

/** 既可以是连接池上的实例，也可以是租户会话（单连接）上的实例。 */
export type Db = NodePgDatabase<typeof schema>;
export type DbHandle = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
