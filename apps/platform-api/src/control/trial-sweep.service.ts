import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { platformAudit, subscriptions, tenants } from "@weave-order/control-db";
import { createNotifier, trialEndingMessage } from "@weave-order/notify";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import { loadEnv } from "../env";
import { AuditService } from "./audit.service";
import type { PlatformActor } from "../auth/auth.service";

const SWEEP_ACTOR: PlatformActor = {
  id: "trial-sweep",
  sub: "trial-sweep",
  name: "试用到期任务",
  email: "noreply@weaveorder.cn",
  role: "platform_ops",
  permissions: [],
};

export interface TrialSweepResult {
  /** 提前 1 天发出提醒的数量（含发送失败，失败也会记审计）。 */
  reminded: number;
  /** 试用到期、已转只读的数量。 */
  suspended: number;
  /** 提前一天内已提醒过、本次跳过。 */
  skipped: number;
}

/**
 * 试用到期任务。
 *
 * 两条规则（与官网承诺一致）：
 * 1. 到期前 1 天提醒一次，不自动扣费；
 * 2. 到期当天把租户转成只读（`SUSPENDED`），数据保留，运营可随时恢复或转正。
 *
 * 幂等：提醒前查平台审计里最近 2 天是否已提醒过同一租户，避免 cron 重跑发两条。
 * 由 `pnpm platform:trial-sweep`（cron / systemd timer）或后台接口手动触发。
 */
@Injectable()
export class TrialSweepService {
  private readonly logger = new Logger(TrialSweepService.name);

  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: PlatformDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async run(now: Date = new Date()): Promise<TrialSweepResult> {
    const result: TrialSweepResult = { reminded: 0, suspended: 0, skipped: 0 };
    const soon = new Date(now.getTime() + 24 * 3600 * 1000);

    // 1) 提前一天提醒
    const ending = await this.db
      .select({ subscription: subscriptions, tenant: tenants })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .where(
        and(
          eq(subscriptions.status, "TRIAL"),
          isNotNull(subscriptions.trialEndsAt),
          gte(subscriptions.trialEndsAt, now),
          lte(subscriptions.trialEndsAt, soon),
        ),
      );

    const notifier = this.notifier();
    for (const row of ending) {
      if (await this.remindedRecently(row.tenant.id, now)) {
        result.skipped += 1;
        continue;
      }
      const email = row.tenant.contactEmail;
      const endsAt = row.subscription.trialEndsAt ?? now;
      const send = email
        ? await notifier.send(
            trialEndingMessage({
              channel: "email",
              to: email,
              tenantName: row.tenant.name,
              endsAt,
            }),
          )
        : { ok: false, provider: "log", detail: "租户没有联系人邮箱" };

      await this.audit.record(SWEEP_ACTOR, {
        action: "TRIAL_ENDING_SOON",
        targetType: "tenant",
        targetId: row.tenant.id,
        after: {
          trialEndsAt: endsAt.toISOString(),
          contactEmail: email ? maskEmail(email) : null,
          delivered: send.ok,
          detail: send.detail ?? null,
        },
        reason: "试用到期前 1 天提醒",
      });
      result.reminded += 1;
    }

    // 2) 到期转只读
    const expired = await this.db
      .select({ subscription: subscriptions, tenant: tenants })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .where(
        and(
          eq(subscriptions.status, "TRIAL"),
          isNotNull(subscriptions.trialEndsAt),
          lte(subscriptions.trialEndsAt, now),
        ),
      );

    for (const row of expired) {
      if (row.tenant.status !== "TRIAL") continue;
      await this.db.transaction(async (tx) => {
        await tx
          .update(tenants)
          .set({
            status: "SUSPENDED",
            suspendedAt: now,
            notes: appendNote(
              row.tenant.notes,
              `${now.toISOString().slice(0, 10)} 试用到期，转只读`,
            ),
            updatedAt: now,
          })
          .where(eq(tenants.id, row.tenant.id));
        await tx
          .update(subscriptions)
          .set({ status: "SUSPENDED", updatedAt: now })
          .where(eq(subscriptions.tenantId, row.tenant.id));
      });
      await this.audit.record(SWEEP_ACTOR, {
        action: "TRIAL_EXPIRED",
        targetType: "tenant",
        targetId: row.tenant.id,
        before: { status: "TRIAL" },
        after: { status: "SUSPENDED", trialEndsAt: row.subscription.trialEndsAt?.toISOString() },
        reason: "试用到期，账号转只读（数据保留 30 天）",
      });
      result.suspended += 1;
    }

    this.logger.log(
      `trial-sweep: reminded=${result.reminded} suspended=${result.suspended} skipped=${result.skipped}`,
    );
    return result;
  }

  private notifier() {
    const env = loadEnv();
    return createNotifier({
      provider: env.NOTIFY_PROVIDER,
      webhookUrl: env.NOTIFY_WEBHOOK_URL,
      token: env.NOTIFY_TOKEN,
    });
  }

  /** 同一租户 2 天内提醒过就跳过，cron 一天跑多次也不会重复发。 */
  private async remindedRecently(tenantId: string, now: Date): Promise<boolean> {
    const since = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
    const rows = await this.db
      .select({ id: platformAudit.id })
      .from(platformAudit)
      .where(
        and(
          eq(platformAudit.action, "TRIAL_ENDING_SOON"),
          eq(platformAudit.targetId, tenantId),
          gte(platformAudit.createdAt, since),
        ),
      )
      .orderBy(desc(platformAudit.createdAt))
      .limit(1);
    return rows.length > 0;
  }
}

function appendNote(notes: string | null, line: string): string {
  return notes ? `${notes}\n${line}` : line;
}

function maskEmail(email: string): string {
  const [name = "", domain] = email.split("@");
  return domain ? `${name.slice(0, 2)}***@${domain}` : "***";
}
