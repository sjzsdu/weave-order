import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { createPlatformDb } from "./client";
import { resolvePlatformDatabaseUrl } from "./env";

/**
 * 控制面迁移：
 * 1. 目标库不存在时先用同一凭据在 maintenance 库 CREATE DATABASE；
 * 2. 跑 drizzle 下生成的迁移（建 control schema、表、枚举、序列）；
 * 3. 套用平台侧附加 SQL（审计只追加触发器）；
 * 4. 写入默认套餐与初始价格表（幂等，空控制面也能直接开通租户）。
 *
 * 与租户库迁移完全分开：`pnpm db:migrate` 永远不会碰控制面。
 */
async function ensureDatabase(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const databaseName = target.pathname.replace(/^\//, "");
  if (!databaseName) throw new Error("PLATFORM_DATABASE_URL 缺少数据库名");

  const maintenance = new URL(databaseUrl);
  maintenance.pathname = "/postgres";
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      const quoted = `"${databaseName.replace(/"/g, '""')}"`;
      await client.query(`CREATE DATABASE ${quoted}`);
      console.log(`✔ 已创建控制面数据库：${databaseName}`);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = resolvePlatformDatabaseUrl();
  await ensureDatabase(databaseUrl);

  const { db, pool } = createPlatformDb(databaseUrl);
  try {
    await migrate(db, {
      migrationsFolder: path.join(__dirname, "..", "drizzle"),
    });
    const sql = await readFile(path.join(__dirname, "..", "sql", "platform.sql"), "utf8");
    await pool.query(sql);
    // 默认套餐与初始价格表：控制面冷启动必需，幂等，已存在不覆盖。
    const defaults = await readFile(
      path.join(__dirname, "..", "sql", "platform-defaults.sql"),
      "utf8",
    );
    await pool.query(defaults);
    console.log(`✔ 控制面迁移已应用：${databaseUrl}`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` ← ${error.cause.message}` : "";
  console.error("✖ 控制面迁移失败：", error instanceof Error ? `${error.message}${cause}` : error);
  process.exitCode = 1;
});
