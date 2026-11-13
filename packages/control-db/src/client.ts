import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * 控制面连接：独立数据库（默认 weave_platform），与租户业务库无任何共享连接。
 * 只允许 apps/platform-api 引用；apps/api 不 import 本模块（隔离测试会守住）。
 */
export function createPlatformDb(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

export type PlatformDb = NodePgDatabase<typeof schema>;
export type PlatformDbHandle = ReturnType<typeof createPlatformDb>;
