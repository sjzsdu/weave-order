import { intents } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { IntentView, SubmitIntentInput } from "@weave-order/schema";
import type {
  IntentDraft,
  IntentUnderstanding,
  IntentView as IntentViewType,
  SubmitInboundInput,
  SubmitIntentInput as SubmitIntentInputType,
  SubmitIntentResult,
} from "@weave-order/schema";
import { and, desc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import { sanitizeUserNotice } from "../platform/notice-text";
import {
  assertIntentTransition,
  canRestartIntent,
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
 * 执行器接线状态。
 *
 * WAN-172：桌面链路已接通「意图 → 报价 agent → 报价草稿」的执行器（见
 * `http/intent-executor.service.ts`），提交后立刻进入 RUNNING。
 * 仍保留 NOT_CONNECTED 分支，是为了识别历史遗留的 QUEUED 行，界面继续诚实显示「待受理」。
 */
const EXECUTOR_STATE = "CONNECTED" as const;

function mapRow(row: IntentRow): IntentViewType {
  const executorState = row.executorState === "CONNECTED" ? "CONNECTED" : "NOT_CONNECTED";
  const draft = row.result ?? null;
  // 历史行可能存着网关原文；读侧统一洗掉，旧卡片也不会再把 HTTP 403 / 令牌抛给用户。
  const failureReason = sanitizeUserNotice(row.failureReason);
  // 理解卡已就绪但尚未执行：SUCCEEDED 指的是「这次理解成功了」，不是「业务完成了」。
  const awaitingConfirm = row.status === "SUCCEEDED" && row.understanding !== null && !draft;
  return IntentView.parse({
    id: row.id,
    tenantId: row.tenantId,
    text: row.text,
    source: row.source,
    status: row.status,
    statusLabel: awaitingConfirm ? "理解卡已就绪，待确认" : INTENT_STATUS_LABEL[row.status],
    executorState,
    notice: awaitingConfirm
      ? "先确认理解卡，或逐字段纠正后再执行。"
      : intentNotice({
          status: row.status,
          executorState,
          failureReason,
        }),
    failureReason,
    draft,
    attachments: row.attachments ?? [],
    understanding: row.understanding ?? null,
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
   * 统一输入：文本可空，但必须有至少一个附件；幂等键与旧意图共用同一列。
   * `text` 为空时落一句可读占位，读模型 `IntentView.text` 要求非空。
   */
  async submitInbound(
    input: SubmitInboundInput,
    ctx: KernelContext,
  ): Promise<{ intent: IntentViewType; created: boolean; row: IntentRow }> {
    const text = input.text?.trim() || "（图片输入，无文字说明）";
    const inserted = await this.db
      .insert(intents)
      .values({
        tenantId: this.tenantId,
        clientRequestId: input.clientRequestId,
        source: input.source,
        text,
        context: input.context ?? null,
        status: "QUEUED",
        executorState: EXECUTOR_STATE,
        submittedBy: ctx.actor.id,
      })
      .onConflictDoNothing({ target: [intents.tenantId, intents.clientRequestId] })
      .returning();
    const created = inserted.length > 0;
    const row = inserted[0] ?? (await this.findByClientRequestId(input.clientRequestId));
    return { intent: mapRow(row), created, row };
  }

  /** 附件（`sources`）在提交之后创建，创建成功后回写到意图行。 */
  async attachSources(id: string, sourceIds: string[]): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.db
      .update(intents)
      .set({ attachments: sourceIds, updatedAt: new Date() })
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)));
  }

  /** 理解/执行重新开始：允许从 SUCCEEDED / NEEDS_INPUT / FAILED 继续，不重述背景。 */
  async resumeRunning(id: string): Promise<IntentViewType> {
    const row = await this.find(id);
    if (row.status === "CANCELLED") {
      throw new KernelError("KERNEL_REJECTED", "这条输入已撤销，不能再执行", {
        reason: "INTENT_CANCELLED",
        resourceType: "intent",
        resourceId: id,
      });
    }
    if (!canRestartIntent(row.status)) {
      throw new KernelError("KERNEL_REJECTED", `当前状态 ${row.status} 不能重新开始`, {
        reason: "INTENT_NOT_RESUMABLE",
        resourceType: "intent",
        resourceId: id,
      });
    }
    if (row.status === "RUNNING") return mapRow(row);
    const rows = await this.db
      .update(intents)
      .set({
        status: "RUNNING",
        executorState: "CONNECTED",
        startedAt: new Date(),
        finishedAt: null,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)))
      .returning();
    return mapRow(this.requireRow(rows[0], id));
  }

  /** 理解卡就绪 / 还差信息。SUCCEEDED 在此只表示「理解完成」，业务结果看 `result`。 */
  async saveUnderstanding(
    id: string,
    understanding: IntentUnderstanding,
    ready: boolean,
    reason: string | null,
  ): Promise<IntentViewType> {
    const row = await this.find(id);
    if (row.status === "CANCELLED") return mapRow(row);
    const rows = await this.db
      .update(intents)
      .set({
        status: ready ? "SUCCEEDED" : "NEEDS_INPUT",
        understanding,
        failureReason: ready ? null : (reason ?? "还差一些信息").slice(0, 500),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)))
      .returning();
    return mapRow(this.requireRow(rows[0], id));
  }

  /** 执行完成后由执行器回写草稿指针；`result` 只存主产物。 */
  async completeInbound(
    id: string,
    draft: IntentDraft,
    understanding: IntentUnderstanding,
  ): Promise<IntentViewType> {
    const row = await this.find(id);
    if (row.status === "CANCELLED") return mapRow(row);
    const rows = await this.db
      .update(intents)
      .set({
        status: "SUCCEEDED",
        result: draft,
        understanding,
        failureReason: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(intents.tenantId, this.tenantId), eq(intents.id, id)))
      .returning();
    return mapRow(this.requireRow(rows[0], id));
  }

  /** 供统一输入服务读取原始行（understanding / attachments 不经过读模型）。 */
  async getRow(id: string): Promise<IntentRow> {
    return this.find(id);
  }

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

  /**
   * 报价 agent 跑完但缺阻断项（客户 / 样品 / 数量）：不是失败，原话保留可重试。
   * `failureReason` 复用来承载「还差什么」，避免再加一列。
   */
  async markNeedsInput(id: string, reason: string): Promise<IntentViewType> {
    const row = await this.find(id);
    assertIntentTransition(row.status, "NEEDS_INPUT");
    const rows = await this.db
      .update(intents)
      .set({
        status: "NEEDS_INPUT",
        failureReason: reason.slice(0, 500),
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
