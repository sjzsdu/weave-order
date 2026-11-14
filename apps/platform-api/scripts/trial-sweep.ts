import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { TrialSweepService } from "../src/control/trial-sweep.service";

/**
 * 试用到期任务（cron / systemd timer 调用）。
 *
 *   pnpm platform:trial-sweep
 *
 * 做两件事：到期前 1 天提醒一次；到期当天把租户转只读。
 * 幂等：提醒前查 2 天内是否已提醒过，cron 重跑不会重复发。
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });
  try {
    const result = await app.get(TrialSweepService).run();
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
