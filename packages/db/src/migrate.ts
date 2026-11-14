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

/** 沿 cause 链找第一条消息：drizzle 会把 PG 错误包好几层。 */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(typeof current === "string" ? current : JSON.stringify(current));
      break;
    }
  }
  return parts.join(" ← ");
}

/**
 * pgvector 不是 PG 内置扩展：非 superuser / 缺扩展包时报错原文各不相同，
 * 但都指向同一件事。这里翻译成可执行的提示（验收要求 PR 里点名 DBA）。
 */
function vectorExtensionHint(message: string): string | null {
  const lower = message.toLowerCase();
  const extensionProblem =
    lower.includes("permission denied to create extension") ||
    lower.includes('extension "vector" is not available') ||
    lower.includes("could not open extension control file") ||
    (lower.includes('extension "vector"') && lower.includes("does not exist"));
  if (!extensionProblem) return null;
  return (
    "pgvector 扩展不可用：请 DBA 在目标库执行 `CREATE EXTENSION vector;`" +
    "（镜像 pgvector/pgvector:pg16 已内置；生产库需由有权限的角色安装），然后重跑 pnpm db:migrate。"
  );
}

void main().catch((error: unknown) => {
  const message = errorChainText(error);
  console.error("✖ 迁移失败：", message || "未知错误");
  const hint = vectorExtensionHint(message);
  if (hint) {
    console.error(`  提示：${hint}`);
  } else if (/already exists/i.test(message)) {
    console.error(
      "  提示：若报 already exists / 记录与 journal 不一致，先跑 pnpm db:repair 体检（只读），不要删库重建。",
    );
  }
  process.exitCode = 1;
});
