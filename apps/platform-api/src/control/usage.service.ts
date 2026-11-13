import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql, sum } from "drizzle-orm";
import { UsageEventInput, UsageOverview } from "@weave-order/schema";
import type { UsageDay, UsageOverview as UsageOverviewType } from "@weave-order/schema";
import { plans, subscriptions, tenants, usageDaily, usageEvents } from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import { notFound } from "../domain/errors";
import { currentMonthPeriod } from "./util";

/**
 * 用量计量：事件幂等（idempotency_key 唯一），按天聚合。
 * 控制面只保留聚合，不落业务明细；token 只核算成本，不计费。
 */
@Injectable()
export class UsageService {
  constructor(@Inject(PLATFORM_DATABASE) private readonly db: PlatformDb) {}

  async ingest(raw: unknown): Promise<{ inserted: boolean }> {
    const input = UsageEventInput.parse(raw);
    const tenant = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    if (!tenant[0]) throw notFound("租户不存在");

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const day = occurredAt.toISOString().slice(0, 10);
    const meta = (input.meta ?? {}) as Record<string, unknown>;

    const inserted = await this.db.transaction(async (tx) => {
      const events = await tx
        .insert(usageEvents)
        .values({
          tenantId: input.tenantId,
          kind: input.kind,
          quantity: String(input.quantity),
          idempotencyKey: input.idempotencyKey,
          occurredAt,
          meta: input.meta ?? {},
        })
        .onConflictDoNothing({ target: usageEvents.idempotencyKey })
        .returning({ id: usageEvents.id });
      if (!insertedRow(events)) return false;

      const base = {
        tenantId: input.tenantId,
        day,
        agentActions: 0,
        storageGb: "0",
        smsCount: 0,
        llmInputTokens: 0,
        llmOutputTokens: 0,
        llmCostCents: 0,
      };
      const values =
        input.kind === "agent_action"
          ? { ...base, agentActions: Math.round(input.quantity) }
          : input.kind === "sms"
            ? { ...base, smsCount: Math.round(input.quantity) }
            : input.kind === "storage"
              ? { ...base, storageGb: String(input.quantity) }
              : {
                  ...base,
                  llmInputTokens: Number(meta.inputTokens ?? Math.round(input.quantity / 2)),
                  llmOutputTokens: Number(meta.outputTokens ?? Math.ceil(input.quantity / 2)),
                  llmCostCents: Number(meta.costCents ?? 0),
                };

      await tx
        .insert(usageDaily)
        .values(values)
        .onConflictDoUpdate({
          target: [usageDaily.tenantId, usageDaily.day],
          set:
            input.kind === "agent_action"
              ? {
                  agentActions: sql`${usageDaily.agentActions} + ${Math.round(input.quantity)}`,
                  updatedAt: new Date(),
                }
              : input.kind === "sms"
                ? {
                    smsCount: sql`${usageDaily.smsCount} + ${Math.round(input.quantity)}`,
                    updatedAt: new Date(),
                  }
                : input.kind === "storage"
                  ? {
                      storageGb: sql`${usageDaily.storageGb} + ${input.quantity}`,
                      updatedAt: new Date(),
                    }
                  : {
                      llmInputTokens: sql`${usageDaily.llmInputTokens} + ${values.llmInputTokens}`,
                      llmOutputTokens: sql`${usageDaily.llmOutputTokens} + ${values.llmOutputTokens}`,
                      llmCostCents: sql`${usageDaily.llmCostCents} + ${values.llmCostCents}`,
                      updatedAt: new Date(),
                    },
        });
      return true;
    });

    return { inserted };
  }

  async month(tenantId: string): Promise<{ usage: UsageDay[]; state: string }> {
    const period = `${currentMonthPeriod()}-01`;
    const rows = await this.db
      .select()
      .from(usageDaily)
      .where(and(eq(usageDaily.tenantId, tenantId), gte(usageDaily.day, period)))
      .orderBy(usageDaily.day);
    const sub = await this.db
      .select({ planCode: subscriptions.planCode })
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .limit(1);
    const plan = sub[0]
      ? await this.db.select().from(plans).where(eq(plans.code, sub[0].planCode)).limit(1)
      : [];
    const used = rows.reduce((total, row) => total + row.agentActions, 0);
    const quota = plan[0]?.agentActionsQuota ?? 0;
    return { usage: rows.map((row) => mapDay(row)), state: quotaState(used, quota) };
  }

  /** 当前月全局用量：Top 消耗 + 异常（超额 / 存储超套餐）。 */
  async overview(): Promise<UsageOverviewType> {
    const period = currentMonthPeriod();
    const from = `${period}-01`;
    const to = new Date().toISOString().slice(0, 10);

    const rows = await this.db
      .select({
        tenantId: usageDaily.tenantId,
        tenantName: tenants.name,
        agentActions: sum(usageDaily.agentActions),
        storageGb: sum(usageDaily.storageGb),
        smsCount: sum(usageDaily.smsCount),
        inputTokens: sum(usageDaily.llmInputTokens),
        outputTokens: sum(usageDaily.llmOutputTokens),
        costCents: sum(usageDaily.llmCostCents),
        planCode: subscriptions.planCode,
        quota: plans.agentActionsQuota,
        planStorage: plans.storageGb,
      })
      .from(usageDaily)
      .innerJoin(tenants, eq(tenants.id, usageDaily.tenantId))
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(and(gte(usageDaily.day, from), lte(usageDaily.day, to)))
      .groupBy(
        usageDaily.tenantId,
        tenants.name,
        subscriptions.planCode,
        plans.agentActionsQuota,
        plans.storageGb,
      );

    const mapped = rows.map((row) => ({
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      agentActions: Number(row.agentActions ?? 0),
      storageGb: Number(row.storageGb ?? 0),
      smsCount: Number(row.smsCount ?? 0),
      llmTokens: Number(row.inputTokens ?? 0) + Number(row.outputTokens ?? 0),
      llmCostCents: Number(row.costCents ?? 0),
      quota: row.quota ?? 0,
      planStorage: row.planStorage ?? 0,
    }));

    const anomalies = mapped.flatMap((row) => {
      const items: UsageOverviewType["anomalies"] = [];
      if (row.quota > 0 && row.agentActions > row.quota) {
        items.push({
          tenantId: row.tenantId,
          tenantName: row.tenantName,
          metric: "agent_actions",
          message: `agent 动作 ${row.agentActions} 已超过套餐额度 ${row.quota}`,
        });
      }
      if (row.planStorage > 0 && row.storageGb > row.planStorage) {
        items.push({
          tenantId: row.tenantId,
          tenantName: row.tenantName,
          metric: "storage",
          message: `存储 ${row.storageGb.toFixed(1)}GB 已超过套餐 ${row.planStorage}GB`,
        });
      }
      return items;
    });

    return UsageOverview.parse({
      period,
      totalAgentActions: mapped.reduce((sumValue, row) => sumValue + row.agentActions, 0),
      totalStorageGb: Number(
        mapped.reduce((sumValue, row) => sumValue + row.storageGb, 0).toFixed(3),
      ),
      totalSms: mapped.reduce((sumValue, row) => sumValue + row.smsCount, 0),
      totalLlmTokens: mapped.reduce((sumValue, row) => sumValue + row.llmTokens, 0),
      totalLlmCostCents: mapped.reduce((sumValue, row) => sumValue + row.llmCostCents, 0),
      topConsumers: [...mapped]
        .sort((a, b) => b.agentActions - a.agentActions)
        .slice(0, 5)
        .map((row) => ({
          tenantId: row.tenantId,
          tenantName: row.tenantName,
          agentActions: row.agentActions,
          storageGb: row.storageGb,
          llmCostCents: row.llmCostCents,
        })),
      anomalies,
    });
  }

  async recentEvents(tenantId: string, limit = 50) {
    const rows = await this.db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.tenantId, tenantId))
      .orderBy(desc(usageEvents.occurredAt))
      .limit(Math.min(limit, 200));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      quantity: Number(row.quantity),
      idempotencyKey: row.idempotencyKey,
      occurredAt: row.occurredAt.toISOString(),
    }));
  }
}

function quotaState(used: number, quota: number): "OK" | "WARN" | "BLOCK_NEW" | "REJECT" {
  if (quota <= 0) return "OK";
  const ratio = used / quota;
  if (ratio >= 1.1) return "REJECT";
  if (ratio >= 1) return "BLOCK_NEW";
  if (ratio >= 0.8) return "WARN";
  return "OK";
}

function insertedRow(rows: { id: string }[]): boolean {
  return rows.length > 0;
}

function mapDay(row: typeof usageDaily.$inferSelect): UsageDay {
  return {
    day: row.day,
    agentActions: row.agentActions,
    storageGb: Number(row.storageGb),
    smsCount: row.smsCount,
    llmInputTokens: row.llmInputTokens,
    llmOutputTokens: row.llmOutputTokens,
    llmCostCents: row.llmCostCents,
  };
}
