/**
 * 清空到期的客户回复原始 payload（合规：默认保留 30 天）。
 *
 * 只清 `raw_payload`，不删业务行：时间线、审计口径与已脱敏正文都保留。
 * 由部署环境的定时任务调用（例如每天一次 `pnpm --filter @weave-order/api maintain:inbound`）。
 */
import { connectDatabase } from "../src/platform/database";
import { loadEnv } from "../src/platform/env";

async function main(): Promise<void> {
  const env = loadEnv();
  const handle = connectDatabase(env.DATABASE_URL);
  try {
    const result = await handle.pool.query<{ id: string }>(
      `UPDATE inbound_messages
          SET raw_payload = NULL
        WHERE raw_payload IS NOT NULL
          AND raw_payload_expires_at IS NOT NULL
          AND raw_payload_expires_at < now()
        RETURNING id`,
    );
    console.log(
      `✔ 已清理 ${result.rowCount ?? 0} 条到期原始 payload（保留期 ${env.INBOUND_RAW_RETENTION_DAYS} 天）`,
    );
  } finally {
    await handle.pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 清理失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
