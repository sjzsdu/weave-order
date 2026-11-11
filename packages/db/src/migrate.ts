import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { createDb } from "./client";
import { resolveDatabaseUrl } from "./env";

/**
 * 应用 migrations 目录下的 SQL 迁移。
 * 迁移是幂等的：已应用过的版本记录在 drizzle.__drizzle_migrations。
 */
async function main(): Promise<void> {
  const databaseUrl = resolveDatabaseUrl();
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, {
      migrationsFolder: path.join(__dirname, "..", "drizzle"),
    });
    console.log(`✔ 迁移已应用：${databaseUrl}`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` ← ${error.cause.message}` : "";
  console.error("✖ 迁移失败：", error instanceof Error ? `${error.message}${cause}` : error);
  process.exitCode = 1;
});
