import { intents } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { IntentView, SubmitIntentInput } from "@weave-order/schema";
import type {
  IntentDraft,
  IntentView as IntentViewType,
  SubmitIntentInput as SubmitIntentInputType,
  SubmitIntentResult,
} from "@weave-order/schema";
import { and, desc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import {
  assertIntentTransition,
  intentCancelDeadline,
  intentNotice,
  isIntentCancellable,
  isIntentTimedOut,
  isTerminalIntentStatus,
  INTENT_STATUS_LABEL,
} from "./intent-state";
import { toIso, toIsoOrNull } from "./mappers";

type IntentRow = typeof intents.$inferSelect;

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

/**
 * 当前没有接入真实的意图拆解执行器。
 *
 * 这不是占位代码：它决定了 `POST /api/intents` 的回执写「尚未接入」而不是绿色成功。
 * 未来接入执行器时，替换这个常量并实现 `markRunning` / `markSucceeded` / `markFailed`
 * 的调用方即可，状态机与持久化不用动。
 */
const EXECUTOR_STATE = "NOT_CONNECTED" as const;

function mapRow(row: IntentRow): IntentViewType {
  const executorState = row.executorState === "CONNECTED" ? "CONNECTED" : "NOT_CONNECTED";
  const draft = row.result ?? null;
  return IntentView.parse({
    id: row.id,
    tenantId: row.tenantId,
    text: row.text,
    source: row.source,
    status: row.status,
    statusLabel: INTENT_STATUS_LABEL[row.status],
    executorState,
    notice: intentNotice({
      status: row.status,
      executorState,
      failureReason: row.failureReason,
    }),
    failureReason: row.failureReason,
    draft,
    cancellableUntil: isIntentCancellable(row.status, row.createdAt)
      ? toIso(intentCancelDeadline(row.createdAt))
      : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    startedAt: toIsoOrNull(row.startedAt),
    finishedAt: toIsoOrNull(row.finishedAt),
    cancelledAt: toIsoOrNull(row.cancelledAt),
  });
}

function parseLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIST_LIMIT);
}

/**
 * 意图内核服务：唯一读写 `intents` 表的地方。
 *
 * 不变量：
 * - 提交幂等：`(tenantId, clientRequestId)` 唯一，重复提交返回同一行。
 * - 所有状态变更都过 `assertIntentTransition`，不存在跳级。
 * - 撤销写审计；提交不写审计（意图本身就是可查的事实，避免污染「最近审计」）。
 */
export class IntentService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async submit(raw: unknown, ctx: KernelContext): Promise<SubmitIntentResult> {
    const input: SubmitIntentInputType = SubmitIntentInput.parse(raw);
    const inserted = await this.db
      .insert(intents)
      .values({
        tenantId: this.tenantId,
        clientRequestId: input.clientRequestId,
        source: input.source,
        text: input.text,
        context: input.context ?? null,
        // 执行器未接入：状态停在 QUEUED（待受理），绝不伪装成 RUNNING/SUCCEEDED。
        status: "QUEUED",
        executorState: EXECUTOR_STATE,
        submittedBy: ctx.actor.id,
      })
      .onConflictDoNothing({
        target: [intents.tenantId, intents.clientRequestId],
      })
      .returning();

    const row = inserted[0] ?? (await this.findByClientRequestId(input.clientRequestId));
    const intent = mapRow(row);
    return {
      intentId: intent.id,
      status: intent.status,
      executorState: intent.executorState,
      notice: intent.notice,
      intent,
    };
  }

  /** 近期意图：工作台与顶栏都读同一份，刷新页面后仍能看到上次说了什么。 */
  async list(limit?: number): Promise<IntentViewType[]> {
    const rows = await this.db
      .select()
      .from(intents)
      .where(eq(intents.tenantId, this.tenantId))
      .orderBy(desc(intents.createdAt))
      .limit(parseLimit(limit));
    return Promise.all(rows.map((row) => this.expireIfStale(row)));
  }

  async get(id: string): Promise<IntentViewType> {
    const row = await this.find(id);
    return this.expireIfStale(row);
  }

  /** 撤销：10 分钟内、非终态；写一条审计，审计与状态变更同事务。 */
  async cancel(id: string, ctx: KernelContext): Promise<IntentViewType> {
    const updated = await this.db.transaction(async (tx) => {
      const row = await this.find(id, tx);
      if (isTerminalIntentStatus(row.status)) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `这条意图已经是「${INTENT_STATUS_LABEL[row.status]}」，不能撤销`,
          {
            reason: "INTENT_ALREADY_FINISHED",
            resourceType: "intent",
            resourceId: row.id,
          },
        );
      }
      if (!isIntentCancellable(row.status, row.createdAt)) {
        throw new KernelError("KERNEL_REJECTED", "超过 10 分钟，不能再撤销这条意图", {
          reason: "INTENT_CANCEL_WINDOW_EXPIRED",
          resourceType: "intent",
          resourceId: row.id,
        });
      }
      assertIntentTransition(row.status, "CANCELLED");
      const rows = await tx
        .update(intents)
        .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
        .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)))
        .returning();
      const next = rows[0];
      if (!next) {
        throw new KernelError("RESOURCE_NOT_FOUND", "这条意图不存在", {
          resourceType: "intent",
          resourceId: id,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "INTENT_CANCELLED",
          entityType: "intent",
          entityId: next.id,
          before: { status: row.status },
          after: { status: next.status, text: next.text.slice(0, 500) },
        },
        this.tenantId,
      );
      return next;
    });
    return mapRow(updated);
  }

  /**
   * 执行器接线后由后台任务调用。当前没有任何调用方 —— 保留是为了让
   * 状态机只有一条写入口，接入那天不需要再改表结构。
   */
  async markRunning(id: string): Promise<IntentViewType> {
    const row = await this.find(id);
    assertIntentTransition(row.status, "RUNNING");
    const rows = await this.db
      .update(intents)
      .set({
        status: "RUNNING",
        executorState: "CONNECTED",
        startedAt: new Date(),
        updatedAt: new Date(),
        failureReason: null,
      })
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)))
      .returning();
    return mapRow(this.requireRow(rows[0], id));
  }

  async markSucceeded(id: string, draft: IntentDraft): Promise<IntentViewType> {
    const row = await this.find(id);
    assertIntentTransition(row.status, "SUCCEEDED");
    const rows = await this.db
      .update(intents)
      .set({
        status: "SUCCEEDED",
        result: draft,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)))
      .returning();
    return mapRow(this.requireRow(rows[0], id));
  }

  async markFailed(id: string, reason: string): Promise<IntentViewType> {
    const row = await this.find(id);
    assertIntentTransition(row.status, "FAILED");
    const rows = await this.db
      .update(intents)
      .set({
        status: "FAILED",
        failureReason: reason.slice(0, 500),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)))
      .returning();
    return mapRow(this.requireRow(rows[0], id));
  }

  /**
   * RUNNING 卡住超过 60 秒 → TIMEOUT。
   *
   * 读取路径顺带落库（而不是只在响应里改写），这样部署/重启后仍是一致的终态；
   * 后台清理任务将来可以直接复用这个方法。
   */
  private async expireIfStale(row: IntentRow): Promise<IntentViewType> {
    const since = row.startedAt ?? row.updatedAt;
    if (!isIntentTimedOut(row.status, since)) return mapRow(row);
    const rows = await this.db
      .update(intents)
      .set({
        status: "TIMEOUT",
        failureReason: "超过 60 秒没有结果",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(intents.tenantId, this.tenantId),
          eq(intents.id, row.id),
          // 并发下只允许一条请求完成改写：状态已不是 RUNNING 就放弃。
          eq(intents.status, "RUNNING"),
        ),
      )
      .returning();
    return mapRow(rows[0] ?? row);
  }

  private async find(id: string, db: Db | Tx = this.db): Promise<IntentRow> {
    const rows = await db
      .select()
      .from(intents)
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)))
      .limit(1);
    return this.requireRow(rows[0], id);
  }

  private async findByClientRequestId(clientRequestId: string): Promise<IntentRow> {
    const rows = await this.db
      .select()
      .from(intents)
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.clientRequestId, clientRequestId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("KERNEL_REJECTED", "意图写入失败", {
        reason: "INTENT_INSERT_RETURNED_NO_ROW",
      });
    }
    return row;
  }

  private requireRow(row: IntentRow | undefined, id: string): IntentRow {
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", "这条意图不存在", {
        resourceType: "intent",
        resourceId: id,
      });
    }
    return row;
  }
}
