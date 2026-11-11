import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { Pool } from "pg";

export interface DatabaseHandle {
  db: Db;
  pool: Pool;
}

/** 创建内核数据库连接。只有 kernel / platform 层可调用。 */
export function connectDatabase(databaseUrl: string): DatabaseHandle {
  return createDb(databaseUrl);
}
