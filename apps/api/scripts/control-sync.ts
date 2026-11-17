import "reflect-metadata";
import { DatabaseProvider } from "../src/platform/database.provider";
import { loadEnv } from "../src/platform/env";
import {
  createDrizzleOutboxStore,
  createHttpDeliver,
  runControlSyncOnce,
} from "../src/platform/control-sync";

/**
 * 单轮投递控制面 outbox（供 cron 每 1 分钟跑一次，兜底 API 进程内的定时器）。
 *
 *   pnpm control:sync
 *
 * 与 API 进程内的 ControlSyncService 共用同一套核心逻辑；多处运行无副作用——
 * 控制面登记接口按 slug 幂等，重复投递只会返回 created:false。
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.PLATFORM_API_URL) {
    console.error("✖ 未配置 PLATFORM_API_URL，无法投递控制面 outbox");
    process.exitCode = 1;
    return;
  }
  const database = new DatabaseProvider();
  try {
    const store = createDrizzleOutboxStore(database.handle.db);
    const deliver = createHttpDeliver({
      baseUrl: env.PLATFORM_API_URL,
      secret: env.ONBOARDING_SECRET,
    });
    const result = await runControlSyncOnce(store, deliver, {
      onDead: (job) => console.error(`[control-sync] 死信：${job.slug} 需人工介入`),
    });
    console.log(
      `✔ control-sync: attempted=${result.attempted} synced=${result.synced} failed=${result.failed} dead=${result.dead}`,
    );
  } finally {
    await database.onApplicationShutdown();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ control-sync 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
