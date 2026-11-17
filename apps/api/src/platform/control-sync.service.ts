import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { DatabaseProvider } from "./database.provider";
import { loadEnv } from "./env";
import {
  createDrizzleOutboxStore,
  createHttpDeliver,
  runControlSyncOnce,
  type OutboxJob,
  type SyncResult,
} from "./control-sync";

/**
 * 控制面登记投递的后台服务。
 *
 * 随 API 进程启动，每 30s 跑一轮；也可由 `pnpm control:sync` 脚本单独跑一轮。
 * 三道防线的第二道：outbox 可靠投递（第一道是同事务写 outbox，第三道是对账）。
 */
@Injectable()
export class ControlSyncService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ControlSyncService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(@Inject(DatabaseProvider) private readonly database: DatabaseProvider) {}

  onApplicationBootstrap(): void {
    const env = loadEnv();
    if (!env.PLATFORM_API_URL) {
      // 本地 dev 未配控制面地址：不启动 worker（outbox 仍会落库，配好后由对账补登）。
      this.logger.warn(
        "未配置 PLATFORM_API_URL，控制面投递 worker 未启动（outbox 仍会累积，待对账补登）",
      );
      return;
    }
    // 首轮延迟 5s，避免与启动期的迁移/健康检查争抢连接。
    this.timer = setInterval(() => void this.safeRunOnce(), 30_000);
    setTimeout(() => void this.safeRunOnce(), 5_000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 供脚本与定时器共用；串行执行避免多轮重叠。 */
  async safeRunOnce(): Promise<SyncResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.runOnce();
    } catch (error) {
      this.logger.error("控制面投递轮次异常", error instanceof Error ? error.stack : String(error));
      return null;
    } finally {
      this.running = false;
    }
  }

  async runOnce(): Promise<SyncResult> {
    const env = loadEnv();
    const store = createDrizzleOutboxStore(this.database.handle.db);
    const deliver = createHttpDeliver({
      baseUrl: env.PLATFORM_API_URL ?? "",
      secret: env.ONBOARDING_SECRET,
    });
    const result = await runControlSyncOnce(store, deliver, {
      onDead: (job) => this.alertDead(job),
    });
    if (result.attempted > 0) {
      this.logger.log(
        `control-sync: attempted=${result.attempted} synced=${result.synced} failed=${result.failed} dead=${result.dead}`,
      );
    }
    return result;
  }

  /** 死信告警：配置了 webhook 就发，否则至少留下结构化 error 日志。 */
  private alertDead(job: OutboxJob): void {
    const line = `[control-sync] 死信：租户 ${job.slug} 登记控制面连续失败，需人工介入`;
    this.logger.error(line);
    const env = loadEnv();
    if (env.NOTIFY_WEBHOOK_URL) {
      void fetch(env.NOTIFY_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.NOTIFY_TOKEN ? { Authorization: `Bearer ${env.NOTIFY_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          channel: "email",
          to: "ops@weaveorder.cn",
          subject: "控制面登记死信告警",
          text: `${line}（name=${job.name} attempts 已达上限）`,
        }),
        signal: AbortSignal.timeout(5000),
      }).catch((error) => this.logger.warn("死信告警发送失败", String(error)));
    }
  }
}
