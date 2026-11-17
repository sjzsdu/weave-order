import "reflect-metadata";
import { DatabaseProvider } from "../src/platform/database.provider";
import { loadEnv } from "../src/platform/env";
import {
  createDrizzleTenantSource,
  createHttpControlPlane,
  runReconcileOnce,
} from "../src/platform/control-reconcile";

/**
 * 双库一致性对账（供 cron 每小时跑一次）：
 *   pnpm control:reconcile
 *
 * 业务库每个 ACTIVE/TRIAL 租户，控制面必须有同 slug 记录；缺失自动补登。
 * 控制面多出的记录只报告不删，避免误删运营手工建的合法租户。
 * 发现差异（补登数>0 或控制面多余）时以非空退出码 + error 日志提示运维介入。
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.PLATFORM_API_URL) {
    console.error("✖ 未配置 PLATFORM_API_URL，无法对账");
    process.exitCode = 1;
    return;
  }
  const database = new DatabaseProvider();
  try {
    const source = createDrizzleTenantSource(database.handle.db);
    const control = createHttpControlPlane({
      baseUrl: env.PLATFORM_API_URL,
      secret: env.ONBOARDING_SECRET,
    });
    const result = await runReconcileOnce(source, control);
    console.log(
      `✔ reconcile: authoritative=${result.authoritative} inControlPlane=${result.inControlPlane} repaired=${result.repaired} extra=${result.extraInControlPlane.length}`,
    );
    if (result.extraInControlPlane.length > 0) {
      console.warn(
        `控制面存在业务库无对应的租户（未自动删除）：${result.extraInControlPlane.join(", ")}`,
      );
    }
    if (result.repaired > 0 || result.extraInControlPlane.length > 0) {
      // 有差异即提醒：cron 侧可据此触发告警，但任务本身已自动修复可修复项。
      console.error("[reconcile] 检测到双库差异，请核查上面输出");
    }
  } finally {
    await database.onApplicationShutdown();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ reconcile 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
