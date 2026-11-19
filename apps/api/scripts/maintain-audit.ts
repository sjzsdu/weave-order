/**
 * 审计日志分区维护（WAN-179）。
 *
 * 做两件事，都由数据库函数 `weave_audit_log_maintain` 完成：
 * - 建好本月与未来 3 个月的分区（漏跑也不会写失败：DEFAULT 分区兜底）；
 * - drop 掉整月都早于 24 个月保留期的分区。
 *
 * 部署环境的定时任务每天或每周调用一次即可：
 *   pnpm --filter @weave-order/api maintain:audit
 */
import { connectDatabase } from "../src/platform/database";
import { loadEnv } from "../src/platform/env";

/** 在线保留月数：产品口径为 24 个月（WAN-174 §3.6）。 */
const RETENTION_MONTHS = 24;
/** 提前建几个月的分区；3 个月足够覆盖「定时任务连续失败一个月」的情况。 */
const AHEAD_MONTHS = 3;

async function main(): Promise<void> {
  const env = loadEnv();
  const handle = connectDatabase(env.DATABASE_URL);
  try {
    const result = await handle.pool.query<{ dropped: number }>(
      "SELECT weave_audit_log_maintain($1, $2) AS dropped",
      [RETENTION_MONTHS, AHEAD_MONTHS],
    );
    const dropped = result.rows[0]?.dropped ?? 0;
    console.log(
      `✔ 审计分区已维护：保留 ${RETENTION_MONTHS} 个月，提前建 ${AHEAD_MONTHS} 个月，drop ${dropped} 个超期分区`,
    );
  } finally {
    await handle.pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 审计分区维护失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
