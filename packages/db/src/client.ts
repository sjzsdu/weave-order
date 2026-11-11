import { drizzle } from "drizzle-orm/node-postgres";
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

export type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
