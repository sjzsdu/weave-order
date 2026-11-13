import { tokenUsage, usageMonthly } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { LlmBudgetStatus, RecordTokenUsageInput, TokenUsage } from "@weave-order/schema";
import type { LlmTask } from "@weave-order/schema";
import { and, eq, gte, ne, sql } from "drizzle-orm";

type UsageRow = typeof tokenUsage.$inferSelect;
type Executor = Db | Tx;

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

/** 调用前的预算预留：`reservedTokens` 是本次允许消耗的上限。 */
export interface ReserveUsageInput {
  requestId: string;
  task: LlmTask;
  model: string;
  provider: string;
  promptHash: string;
  reservedTokens: number;
  dailyBudget: number | null;
  monthlyBudget: number | null;
  at?: string | Date;
}

export interface ReserveUsageResult {
  allowed: boolean;
  /** 决策时的预算快照（dailyTokens / monthlyTokens 为已用 + 已预留，不含本次）。 */
  status: LlmBudgetStatus;
}

/** 调用成功后的实际结算。 */
export interface SettleUsageInput {
  requestId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  costMicros?: number | null;
  at?: string | Date;
}

/** 调用失败（超时 / 非 2xx / 空回复）时的计量；已知 token 计入月度汇总。 */
export interface FailUsageInput {
  requestId: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  at?: string | Date;
}

/**
 * token 计量：只记账，不收费。
 *
 * - `token_usage.request_id` 唯一：网关重试 / 客户端重放不会重复计量。
 * - 生命周期 RESERVED → SETTLED / FAILED：调用前先占预算，成功按实际结算，失败也留痕。
 * - 预算 = 已用 + 已预留：`greatest(实际 token, 预留上限)` 逐行汇总，并发不会穿透。
 * - 同一事务里累加 `usage_monthly`（按 月份 × 模型 × 任务），每日调用即时汇总。
 * - prompt 只落 SHA-256，不落原文。
 */
export class UsageService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  /**
   * 预算检查 + 预留必须原子：租户级 advisory 锁把「读已用」和「写预留」放进同一临界区，
   * 否则并发请求各自读到同一份「已用 X/预算 Y」全部放行（WAN-101）。
   */
  async reserve(input: ReserveUsageInput): Promise<ReserveUsageResult> {
    if (!Number.isInteger(input.reservedTokens) || input.reservedTokens < 0) {
      throw new Error(`预留 token 必须是非负整数：${input.reservedTokens}`);
    }
    const at = input.at ? new Date(input.at) : new Date();

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${this.tenantId})::bigint)`);

      // 同一事务单连接：串行查询，避免驱动层并发复用连接。
      const dailyTokens = await this.sumTokens(tx, dayStart(at));
      const monthlyTokens = await this.sumTokens(tx, monthStart(at));
      const nextDaily = dailyTokens + input.reservedTokens;
      const nextMonthly = monthlyTokens + input.reservedTokens;
      const status = LlmBudgetStatus.parse({
        period: at.toISOString().slice(0, 7),
        dailyTokens,
        monthlyTokens,
        dailyBudget: input.dailyBudget,
        monthlyBudget: input.monthlyBudget,
        dailyExceeded: input.dailyBudget !== null && nextDaily > input.dailyBudget,
        monthlyExceeded: input.monthlyBudget !== null && nextMonthly > input.monthlyBudget,
      });
      if (status.dailyExceeded || status.monthlyExceeded) {
        return { allowed: false, status };
      }

      // request_id 已存在时（客户端重放）沿用已有预留，不重复占用预算。
      await tx
        .insert(tokenUsage)
        .values({
          tenantId: this.tenantId,
          requestId: input.requestId,
          task: input.task,
          model: input.model,
          provider: input.provider,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          costMicros: null,
          promptHash: input.promptHash,
          reservedTokens: input.reservedTokens,
          status: "RESERVED",
          createdAt: at,
        })
        .onConflictDoNothing({ target: tokenUsage.requestId });

      return { allowed: true, status };
    });
  }

  /** 成功结算：释放预留、写入实际 usage，并累加月度汇总（幂等）。 */
  async settle(input: SettleUsageInput): Promise<void> {
    const at = input.at ? new Date(input.at) : new Date();
    const promptTokens = nonNegativeInt(input.promptTokens, "promptTokens");
    const completionTokens = nonNegativeInt(input.completionTokens, "completionTokens");
    const cachedTokens = nonNegativeInt(input.cachedTokens ?? 0, "cachedTokens");

    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(tokenUsage)
        .set({
          model: input.model,
          promptTokens,
          completionTokens,
          cachedTokens,
          costMicros: input.costMicros ?? null,
          reservedTokens: 0,
          status: "SETTLED",
        })
        .where(
          and(
            eq(tokenUsage.tenantId, this.tenantId),
            eq(tokenUsage.requestId, input.requestId),
            ne(tokenUsage.status, "SETTLED"),
          ),
        )
        .returning();

      const row = updated[0];
      if (!row) {
        const existing = await tx
          .select()
          .from(tokenUsage)
          .where(
            and(eq(tokenUsage.tenantId, this.tenantId), eq(tokenUsage.requestId, input.requestId)),
          )
          .limit(1);
        if (!existing[0]) {
          throw new Error(`结算找不到预留记录：${input.requestId}`);
        }
        // 已结算：幂等，不重复累加月度汇总。
        return;
      }

      await addMonthly(tx, this.tenantId, row, {
        promptTokens,
        completionTokens,
        cachedTokens,
        costMicros: input.costMicros ?? 0,
        at,
      });
    });
  }

  /**
   * 失败计量：保留预留额度（上游失败也可能已产生费用），有已知 usage 时覆盖 token。
   * 状态已非 RESERVED（重放 / 已结算）时幂等返回。
   */
  async fail(input: FailUsageInput): Promise<void> {
    const at = input.at ? new Date(input.at) : new Date();
    const promptTokens = nonNegativeInt(input.promptTokens ?? 0, "promptTokens");
    const completionTokens = nonNegativeInt(input.completionTokens ?? 0, "completionTokens");
    const cachedTokens = nonNegativeInt(input.cachedTokens ?? 0, "cachedTokens");

    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(tokenUsage)
        .set({
          promptTokens,
          completionTokens,
          cachedTokens,
          status: "FAILED",
        })
        .where(
          and(
            eq(tokenUsage.tenantId, this.tenantId),
            eq(tokenUsage.requestId, input.requestId),
            eq(tokenUsage.status, "RESERVED"),
          ),
        )
        .returning();

      const row = updated[0];
      if (!row) return;

      await addMonthly(tx, this.tenantId, row, {
        promptTokens,
        completionTokens,
        cachedTokens,
        costMicros: 0,
        at,
      });
    });
  }

  /** 直接记账（无预留场景 / 历史路径）；request_id 幂等。 */
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
          status: "SETTLED",
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
    return this.sumTokens(this.db, dayStart(now));
  }

  async monthlyTokens(now = new Date()): Promise<number> {
    return this.sumTokens(this.db, monthStart(now));
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
    // 顺序执行：用量统计可能跑在单连接租户会话上，同一 client 并发 query 已被 pg 弃用。
    const dailyTokens = await this.dailyTokens(now);
    const monthlyTokens = await this.monthlyTokens(now);
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

  /**
   * 预算口径 = 已用 + 已预留。
   * 每行取 `greatest(实际 token, 预留上限)`：RESERVED 计预留，SETTLED 预留归零计实际，
   * FAILED 取两者较大值（上游失败已产生费用，不能按 0 计）。
   */
  private async sumTokens(executor: Executor, since: Date): Promise<number> {
    const rows = await executor
      .select({
        total: sql<string>`coalesce(sum(greatest(${tokenUsage.promptTokens} + ${tokenUsage.completionTokens}, ${tokenUsage.reservedTokens})), 0)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.tenantId, this.tenantId), gte(tokenUsage.createdAt, since)));
    return Number(rows[0]?.total ?? 0);
  }
}

function nonNegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} 必须是非负整数：${value}`);
  }
  return value;
}

/** 结算 / 失败时累加月度汇总；period 跟随预留记录的创建月份。 */
async function addMonthly(
  tx: Tx,
  tenantId: string,
  row: UsageRow,
  actual: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    costMicros: number;
    at: Date;
  },
): Promise<void> {
  const period = periodOf(row.createdAt);
  await tx
    .insert(usageMonthly)
    .values({
      tenantId,
      period,
      model: row.model,
      task: row.task,
      requestCount: 1,
      promptTokens: actual.promptTokens,
      completionTokens: actual.completionTokens,
      cachedTokens: actual.cachedTokens,
      costMicros: actual.costMicros,
      updatedAt: actual.at,
    })
    .onConflictDoUpdate({
      target: [usageMonthly.tenantId, usageMonthly.period, usageMonthly.model, usageMonthly.task],
      set: {
        requestCount: sql`${usageMonthly.requestCount} + 1`,
        promptTokens: sql`${usageMonthly.promptTokens} + ${actual.promptTokens}`,
        completionTokens: sql`${usageMonthly.completionTokens} + ${actual.completionTokens}`,
        cachedTokens: sql`${usageMonthly.cachedTokens} + ${actual.cachedTokens}`,
        costMicros: sql`${usageMonthly.costMicros} + ${actual.costMicros}`,
        updatedAt: actual.at,
      },
    });
}
