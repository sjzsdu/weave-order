/**
 * 存量库迁移记录对齐（WAN-98）。
 *
 * 用法：
 *   pnpm db:repair            # 只读体检：打印对齐计划 + 回滚语句，不写库
 *   pnpm db:repair -- --apply # 单事务执行计划，打印回滚语句
 *
 * 它做什么：
 *  1. 只改 `drizzle.__drizzle_migrations` 的记录（补一条 / 改时间戳），让记录与
 *     `packages/db/drizzle/meta/_journal.json` 一致——不改写任何迁移文件、不动业务数据；
 *  2. 若某迁移「对象完全缺失、却排在已应用水位之前」（drizzle 永远不会重放它），
 *     在同一事务里直接执行它的 DDL 并补记录（仅限纯 DDL 迁移；含 INSERT/DO 的一律报错交给人）。
 *
 * 为何安全：只有「对象状态与迁移断言逐条一致」才允许对齐；「只应用了一半 / 记录有但对象缺失 /
 * 水位会被孤立记录吞掉」等状态一律非 0 退出、拒绝写入。整个 apply 是单事务：任何一步失败全部回滚；
 * 报告里给出每一步的回滚语句（含为直接执行生成的 DROP 语句）。
 */
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { resolveDatabaseUrl } from "./env";
import {
  analyzeEntries,
  buildPlan,
  migrationsTableExists,
  readMigrationEntries,
  readMigrationRecords,
  renderReport,
  stripLeadingComments,
  type RepairPlan,
} from "./migration-state";

const MIGRATIONS_FOLDER = path.join(__dirname, "..", "drizzle");

async function applyPlan(pool: Pool, plan: RepairPlan): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) 被水位挡住的迁移：按 journal 顺序直接执行，并补上与 drizzle 格式一致的记录。
    for (const execution of plan.executions) {
      for (const statement of execution.entry.statements) {
        const sql = stripLeadingComments(statement);
        if (sql !== "") {
          await client.query(sql);
        }
      }
      await client.query(
        `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [execution.entry.hash, execution.entry.when],
      );
      console.log(`  · 已执行 ${execution.entry.tag}（${execution.entry.statements.length} 条语句）`);
    }

    // 2) 记录对齐：补记录 / 改时间戳。
    for (const update of plan.updates) {
      await client.query(
        `UPDATE drizzle."__drizzle_migrations" SET created_at = $1 WHERE id = $2 AND hash = $3`,
        [update.to, update.recordId, update.hash],
      );
    }
    for (const insert of plan.inserts) {
      await client.query(
        `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [insert.hash, insert.when],
      );
    }

    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    if (!(await migrationsTableExists(pool))) {
      console.log(
        "✔ drizzle.__drizzle_migrations 不存在：这是全新库，直接运行 pnpm db:migrate 即可。",
      );
      return;
    }

    const entries = readMigrationEntries(MIGRATIONS_FOLDER);
    const records = await readMigrationRecords(pool);
    const analyses = await analyzeEntries(pool, entries, records);
    const plan = buildPlan(analyses, records);

    if (plan.errors.length > 0) {
      console.log(renderReport(plan, databaseUrl, records.length, false));
      console.error("✖ 存在阻断问题，未做任何修改。");
      process.exitCode = 1;
      return;
    }

    const hasActions =
      plan.updates.length > 0 || plan.inserts.length > 0 || plan.executions.length > 0;

    if (apply && hasActions) {
      console.log("执行对齐（单事务）…");
      await applyPlan(pool, plan);
    }
    console.log(renderReport(plan, databaseUrl, records.length, apply && hasActions));

    if (!apply) {
      if (hasActions) {
        console.log("");
        console.log("以上为只读体检（未写库）；确认后执行：pnpm db:repair -- --apply");
      }
      return;
    }
    if (!hasActions) {
      console.log("✔ 无需写入。");
      return;
    }

    const freshRecords = await readMigrationRecords(pool);
    const freshPlan = buildPlan(await analyzeEntries(pool, entries, freshRecords), freshRecords);
    if (
      freshPlan.errors.length > 0 ||
      freshPlan.updates.length > 0 ||
      freshPlan.inserts.length > 0 ||
      freshPlan.executions.length > 0
    ) {
      console.error("✖ 对齐后复检未通过：状态仍与 journal 不一致。");
      process.exitCode = 1;
      return;
    }
    console.log("");
    console.log("✔ 复检通过：接着运行 pnpm db:migrate（应为无操作），再用 pnpm db:check 验收。");
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 对齐失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
