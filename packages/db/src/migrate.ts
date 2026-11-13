import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createDb } from "./client";
import { resolveDatabaseUrl } from "./env";

/**
 * 应用 migrations 目录下的 SQL 迁移。
 *
 * 注意：drizzle 的重放判定是**时间戳制**——journal 条目 `when > max(created_at)` 就重放，
 * 与 hash 无关；「已应用过就跳过」只在记录与 journal 一致时成立。记录漂移/缺失导致的
 * 重放失败（already exists 等）不要删库重建：先 `pnpm db:repair` 体检并对齐，
 * 手册见 packages/db/README.md。
 */
async function main(): Promise<void> {
  const databaseUrl = resolveDatabaseUrl();
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, {
      migrationsFolder: path.join(__dirname, "..", "drizzle"),
    });
    // 角色与 RLS 策略不是 Drizzle 能表达的部分：迁移后幂等套用。
    const rlsSql = await readFile(path.join(__dirname, "..", "sql", "rls.sql"), "utf8");
    await pool.query(rlsSql);
    console.log(`✔ 迁移已应用：${databaseUrl}`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` ← ${error.cause.message}` : "";
  console.error("✖ 迁移失败：", error instanceof Error ? `${error.message}${cause}` : error);
  console.error("  提示：若报 already exists / 记录与 journal 不一致，先跑 pnpm db:repair 体检（只读），不要删库重建。");
  process.exitCode = 1;
});
