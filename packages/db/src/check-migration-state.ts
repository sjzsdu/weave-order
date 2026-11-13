/**
 * 迁移状态验收（本地 / CI）。
 *
 * 断言：库已经迁移到 HEAD，且 `drizzle.__drizzle_migrations` 的记录与
 * `packages/db/drizzle/meta/_journal.json` 完全一致（没有漂移、没有只应用一半、
 * 没有会被静默跳过的空洞、没有待应用的迁移）。
 *
 * 用法：DATABASE_URL=... pnpm db:check
 * 退出码：0 = 通过；1 = 不通过（报告里写明原因与修复入口）。
 */
import path from "node:path";
import { Pool } from "pg";
import { resolveDatabaseUrl } from "./env";
import {
  analyzeEntries,
  buildPlan,
  migrationsTableExists,
  readMigrationEntries,
  readMigrationRecords,
  renderReport,
} from "./migration-state";

const MIGRATIONS_FOLDER = path.join(__dirname, "..", "drizzle");

async function main(): Promise<void> {
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    if (!(await migrationsTableExists(pool))) {
      console.error("✖ drizzle.__drizzle_migrations 不存在：库还没跑过 pnpm db:migrate。");
      process.exitCode = 1;
      return;
    }

    const entries = readMigrationEntries(MIGRATIONS_FOLDER);
    const records = await readMigrationRecords(pool);
    const plan = buildPlan(await analyzeEntries(pool, entries, records), records);

    const misaligned =
      plan.updates.length > 0 ||
      plan.inserts.length > 0 ||
      plan.executions.length > 0 ||
      plan.pending.length > 0;
    if (plan.errors.length > 0 || misaligned) {
      console.log(renderReport(plan, databaseUrl, records.length, false));
      console.error(
        "✖ 迁移状态验收未通过：" +
          `${plan.errors.length} 个阻断问题、${plan.updates.length} 条待改记录、` +
          `${plan.inserts.length} 条待补记录、${plan.executions.length} 个水位空洞、` +
          `${plan.pending.length} 个待应用迁移。`,
      );
      process.exitCode = 1;
      return;
    }

    const alignedCount = plan.analyses.filter((analysis) => analysis.status.kind === "aligned")
      .length;
    console.log(
      `✔ 迁移状态验收通过：${alignedCount}/${entries.length} 个迁移与 journal 一致，` +
        `水位 max(created_at)=${plan.effectiveMax}，无待应用迁移。` +
        (plan.orphans.length > 0 ? `（另有 ${plan.orphans.length} 条孤立历史记录，仅提示）` : ""),
    );
    for (const warning of plan.warnings) {
      console.log(`  提示：${warning}`);
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 验收失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
