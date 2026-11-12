import { tokenUsage, usageMonthly } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { LlmBudgetStatus, RecordTokenUsageInput, TokenUsage } from "@weave-order/schema";
import type { LlmTask } from "@weave-order/schema";
import { and, eq, gte, sql } from "drizzle-orm";

type UsageRow = typeof tokenUsage.$inferSelect;

function mapUsage(row: UsageRow): TokenUsage {
  return {
    id: row.id,
    tenantId: row.tenantId,
    requestId: row.requestId,
    task: row.task,
    model: row.model,
    provider: row.provider,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cachedTokens: row.cachedTokens,
    costMicros: row.costMicros,
    promptHash: row.promptHash,
    at: row.createdAt.toISOString(),
  };
}

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function periodOf(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

export interface RecordUsageResult {
  /** false = request_id 已存在，本次没有重复计入。 */
  inserted: boolean;
  usage: TokenUsage;
}

/**
 * token 计量：只记账，不收费。
 *
 * - `token_usage.request_id` 唯一：网关重试 / 客户端重放不会重复计量。
 * - 同一事务里累加 `usage_monthly`（按 月份 × 模型 × 任务），每日调用即时汇总。
 * - prompt 只落 SHA-256，不落原文。
 */
export class UsageService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async record(input: unknown): Promise<RecordUsageResult> {
    const parsed = RecordTokenUsageInput.parse(input);
    const at = parsed.at ? new Date(parsed.at) : new Date();
    const period = periodOf(at);

    return this.db.transaction(async (tx) => {
      const insertedRows = await tx
        .insert(tokenUsage)
        .values({
          tenantId: this.tenantId,
          requestId: parsed.requestId,
          task: parsed.task,
          model: parsed.model,
          provider: parsed.provider,
          promptTokens: parsed.promptTokens,
          completionTokens: parsed.completionTokens,
          cachedTokens: parsed.cachedTokens,
          costMicros: parsed.costMicros,
          promptHash: parsed.promptHash,
          createdAt: at,
        })
        .onConflictDoNothing({ target: tokenUsage.requestId })
        .returning();

      const inserted = insertedRows[0];
      if (!inserted) {
        const existing = await tx
          .select()
          .from(tokenUsage)
          .where(eq(tokenUsage.requestId, parsed.requestId))
          .limit(1);
        const row = existing[0];
        if (!row) {
          throw new Error(`用量记录冲突但读不到：${parsed.requestId}`);
        }
        return { inserted: false, usage: mapUsage(row) };
      }

      await tx
        .insert(usageMonthly)
        .values({
          tenantId: this.tenantId,
          period,
          model: parsed.model,
          task: parsed.task,
          requestCount: 1,
          promptTokens: parsed.promptTokens,
          completionTokens: parsed.completionTokens,
          cachedTokens: parsed.cachedTokens,
          costMicros: parsed.costMicros ?? 0,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [
            usageMonthly.tenantId,
            usageMonthly.period,
            usageMonthly.model,
            usageMonthly.task,
          ],
          set: {
            requestCount: sql`${usageMonthly.requestCount} + 1`,
            promptTokens: sql`${usageMonthly.promptTokens} + ${parsed.promptTokens}`,
            completionTokens: sql`${usageMonthly.completionTokens} + ${parsed.completionTokens}`,
            cachedTokens: sql`${usageMonthly.cachedTokens} + ${parsed.cachedTokens}`,
            costMicros: sql`${usageMonthly.costMicros} + ${parsed.costMicros ?? 0}`,
            updatedAt: at,
          },
        });

      return { inserted: true, usage: mapUsage(inserted) };
    });
  }

  async getByRequestId(requestId: string): Promise<TokenUsage | null> {
    const rows = await this.db
      .select()
      .from(tokenUsage)
      .where(eq(tokenUsage.requestId, requestId))
      .limit(1);
    return rows[0] ? mapUsage(rows[0]) : null;
  }

  async dailyTokens(now = new Date()): Promise<number> {
    return this.sumTokens(dayStart(now));
  }

  async monthlyTokens(now = new Date()): Promise<number> {
    return this.sumTokens(monthStart(now));
  }

  async monthlyByTask(
    now = new Date(),
  ): Promise<{ task: LlmTask; model: string; promptTokens: number; completionTokens: number }[]> {
    const rows = await this.db
      .select({
        task: usageMonthly.task,
        model: usageMonthly.model,
        promptTokens: usageMonthly.promptTokens,
        completionTokens: usageMonthly.completionTokens,
      })
      .from(usageMonthly)
      .where(
        and(eq(usageMonthly.tenantId, this.tenantId), gte(usageMonthly.period, periodOf(now))),
      );
    return rows.map((row) => ({
      task: row.task,
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
    }));
  }

  async budgetStatus(
    dailyBudget: number | null,
    monthlyBudget: number | null,
    now = new Date(),
  ): Promise<LlmBudgetStatus> {
    const [dailyTokens, monthlyTokens] = await Promise.all([
      this.dailyTokens(now),
      this.monthlyTokens(now),
    ]);
    return LlmBudgetStatus.parse({
      period: now.toISOString().slice(0, 7),
      dailyTokens,
      monthlyTokens,
      dailyBudget,
      monthlyBudget,
      dailyExceeded: dailyBudget !== null && dailyTokens >= dailyBudget,
      monthlyExceeded: monthlyBudget !== null && monthlyTokens >= monthlyBudget,
    });
  }

  private async sumTokens(since: Date): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${tokenUsage.promptTokens} + ${tokenUsage.completionTokens}), 0)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.tenantId, this.tenantId), gte(tokenUsage.createdAt, since)));
    return Number(rows[0]?.total ?? 0);
  }
}
