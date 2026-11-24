import { randomUUID } from "node:crypto";
import { auditLog, customers, items, quoteItems, quotes, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  CreateItemInput,
  ItemCreateResult,
  ItemDetail,
  ItemListQuery,
  ItemListResponse,
  ITEM_STATUS_TRANSITIONS,
  TransitionItemInput,
  UndoItemTransitionInput,
  canTransitionItemStatus,
  isTerminalItemStatus,
} from "@weave-order/schema";
import type { ItemStatus, ResourceStatus } from "@weave-order/schema";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { decodeCursor, encodeCursor, invalidCursor } from "./cursor";
import { KernelError } from "./errors";
import { quantityToMilli } from "./money";
import { toIso } from "./mappers";

import { createItemTransitionToken, verifyItemTransitionToken } from "./item-transition-token";

type ItemRow = typeof items.$inferSelect;

const STAGE_BY_STATUS: Record<ItemStatus, { stage: string; next: string }> = {
  IN_PROGRESS: { stage: "正在处理", next: "确认最终价格" },
  WAITING_INPUT: { stage: "等待补充信息", next: "补充客户、样品与数量" },
  WAITING_DECISION: { stage: "等待决定", next: "确认或调整方案" },
  COMPLETED: { stage: "已完成", next: "查看结果" },
  CLOSED: { stage: "已关闭", next: "无后续动作" },
};

function mapItem(row: ItemRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    status: row.status,
    customerId: row.customerId,
    sampleId: row.sampleId,
    quantityMilli: row.quantityMilli,
    unit: row.unit,
    currentStage: row.currentStage,
    nextAction: row.nextAction,
    sourceIntentId: row.sourceIntentId,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

interface ItemCursor {
  updatedAt: string;
  id: string;
}

function parseItemCursor(raw: string | null | undefined): ItemCursor | null {
  const decoded = decodeCursor(raw);
  if (!decoded) return null;
  const { updatedAt, id } = decoded;
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) throw invalidCursor();
  if (typeof id !== "string" || id.length === 0) throw invalidCursor();
  return { updatedAt, id };
}

/**
 * 业务事项聚合根。
 *
 * 三条不变量由内核而不是数据库或前端保证：
 * 1. 客户 + 样品 + 数量齐备才创建，缺字段只返回「待补充」；
 * 2. 重复提交命中非终态同类事项时只做软提示（同一组合可以有先后多个事项）；
 * 3. 完成必须有可观察业务结果（已确认报价），不能只改一个状态。
 */
export class ItemService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly undoSecret: string = "weave-order-local-merge-secret",
  ) {}

  async create(input: unknown, ctx: KernelContext): Promise<ItemCreateResult> {
    const parsed = CreateItemInput.parse(input);
    const missing: Array<"customerId" | "sampleId" | "quantity"> = [];
    if (!parsed.customerId) missing.push("customerId");
    if (!parsed.sampleId) missing.push("sampleId");
    if (!parsed.quantity) missing.push("quantity");
    if (missing.length > 0) {
      return ItemCreateResult.parse({
        outcome: "NEEDS_INPUT",
        item: null,
        missingFields: missing,
        message: `还缺${missing
          .map((field) =>
            field === "customerId" ? "客户" : field === "sampleId" ? "样品" : "数量",
          )
          .join("、")}，补齐后再建事项`,
      });
    }

    const customer = await this.requireResource("customer", parsed.customerId!);
    const sample = await this.requireResource("sample", parsed.sampleId!);
    if (customer.status === "DRAFT") {
      throw new KernelError("KERNEL_REJECTED", "草稿客户不能建事项，请先确认可用", {
        reason: "RESOURCE_IS_DRAFT",
        resourceType: "customer",
        resourceId: customer.id,
      });
    }
    if (sample.status === "DRAFT") {
      throw new KernelError("KERNEL_REJECTED", "草稿样品不能建事项，请先确认可用", {
        reason: "RESOURCE_IS_DRAFT",
        resourceType: "sample",
        resourceId: sample.id,
      });
    }
    if (sample.unit !== parsed.quantity!.unit) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `数量单位 ${parsed.quantity!.unit} 与样品 ${sample.code} 的单位 ${sample.unit} 不一致`,
        { reason: "UNIT_MISMATCH" },
      );
    }
    const quantityMilli = quantityToMilli(parsed.quantity!.value);

    const existing = await this.db
      .select()
      .from(items)
      .where(
        and(
          eq(items.tenantId, this.tenantId),
          eq(items.customerId, customer.id),
          eq(items.sampleId, sample.id),
          eq(items.quantityMilli, quantityMilli),
          eq(items.unit, parsed.quantity!.unit),
          notTerminal(),
        ),
      )
      .orderBy(desc(items.updatedAt), desc(items.id))
      .limit(1);
    const duplicate = existing[0];
    if (duplicate) {
      const detail = await this.detailOf(duplicate);
      return ItemCreateResult.parse({
        outcome: "CONTINUED",
        item: detail.item,
        missingFields: [],
        message: "接续已有事项：同客户、同样品、同数量的事项还没结束",
      });
    }

    const defaults = STAGE_BY_STATUS.IN_PROGRESS;
    const row = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(items)
        .values({
          tenantId: this.tenantId,
          status: "IN_PROGRESS",
          customerId: customer.id,
          sampleId: sample.id,
          quantityMilli,
          unit: parsed.quantity!.unit,
          currentStage: parsed.currentStage ?? defaults.stage,
          nextAction: parsed.nextAction ?? defaults.next,
          sourceIntentId: parsed.sourceIntentId ?? null,
          createdBy: ctx.actor.id,
        })
        .returning();
      const inserted = rows[0];
      if (!inserted) {
        throw new KernelError("KERNEL_REJECTED", "事项写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "ITEM_CREATED",
          entityType: "item",
          entityId: inserted.id,
          before: null,
          after: {
            customerId: customer.id,
            sampleId: sample.id,
            quantityMilli,
            unit: inserted.unit,
          },
          entityLabel: `${customer.name} · ${sample.name}`,
        },
        this.tenantId,
      );
      return inserted;
    });

    return ItemCreateResult.parse({
      outcome: "CREATED",
      item: mapItem(row),
      missingFields: [],
      message: "事项已创建",
    });
  }

  async list(input: unknown, ctx?: KernelContext): Promise<ItemListResponse> {
    const parsed = ItemListQuery.parse(input);
    const limit = parsed.limit ?? 20;
    const conditions = [eq(items.tenantId, this.tenantId)];
    if (parsed.status) conditions.push(eq(items.status, parsed.status));
    if (parsed.filter === "mine") {
      conditions.push(eq(items.createdBy, ctx?.actor.id ?? ""));
    }
    const cursor = parseItemCursor(parsed.cursor);
    const where = cursor
      ? and(
          ...conditions,
          or(
            lt(items.updatedAt, new Date(cursor.updatedAt)),
            and(eq(items.updatedAt, new Date(cursor.updatedAt)), lt(items.id, cursor.id)),
          ),
        )
      : and(...conditions);

    const rows = await this.db
      .select()
      .from(items)
      .where(where)
      .orderBy(desc(items.updatedAt), desc(items.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page[page.length - 1];
    return ItemListResponse.parse({
      items: await this.detailsOf(page),
      nextCursor:
        hasMore && last ? encodeCursor({ updatedAt: toIso(last.updatedAt), id: last.id }) : null,
      hasMore,
    });
  }

  async getById(itemId: string): Promise<ItemDetail> {
    const row = await this.requireItem(itemId);
    return this.detailOf(row);
  }

  /** 显式状态迁移（完成走 `complete`，那里还要校验业务结果）。 */
  async transition(itemId: string, input: unknown, ctx: KernelContext): Promise<ItemDetail> {
    const parsed = TransitionItemInput.parse(input);
    const row = await this.requireItem(itemId);
    if (isTerminalItemStatus(row.status)) {
      throw new KernelError("KERNEL_REJECTED", "已结束的事项不能再变更状态", {
        reason: "ITEM_TERMINAL",
      });
    }
    if (parsed.status === "COMPLETED") {
      return this.complete(itemId, ctx);
    }
    if (!canTransitionItemStatus(row.status, parsed.status)) {
      throw new KernelError("KERNEL_REJECTED", `不允许从 ${row.status} 迁移到 ${parsed.status}`, {
        reason: "ITEM_TRANSITION_INVALID",
      });
    }
    const transitionId = randomUUID();
    const updated = await this.db.transaction(async (tx) => {
      // 同一事项的迁移与撤销串行，不能用事务外的状态覆盖他人的更新。
      const [current] = await tx
        .select()
        .from(items)
        .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
        .for("update");
      if (
        !current ||
        current.updatedAt.getTime() !== row.updatedAt.getTime() ||
        current.status !== row.status
      ) {
        throw this.undoMismatch();
      }
      const [result] = await tx
        .update(items)
        .set({
          status: parsed.status,
          currentStage: row.currentStage ?? STAGE_BY_STATUS[parsed.status].stage,
          nextAction: STAGE_BY_STATUS[parsed.status].next,
          updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
        })
        .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
        .returning();
      if (!result) throw this.undoMismatch();
      await appendAudit(
        tx,
        ctx,
        {
          action: "ITEM_STATUS_CHANGED",
          entityType: "item",
          entityId: itemId,
          before: {
            status: row.status,
            currentStage: row.currentStage,
            nextAction: row.nextAction,
          },
          after: { status: parsed.status, note: parsed.note ?? null, transitionId },
        },
        this.tenantId,
      );
      return result;
    });
    const detail = await this.detailOf(updated);
    if (isTerminalItemStatus(updated.status)) return detail;
    const exp = Date.now() + 60_000;
    return {
      ...detail,
      undoUntil: new Date(exp).toISOString(),
      undoToken: createItemTransitionToken(this.undoSecret, {
        purpose: "item-transition-undo",
        tenantId: this.tenantId,
        itemId,
        actorId: ctx.actor.id,
        transitionId,
        from: row.status,
        to: updated.status,
        currentStage: row.currentStage,
        nextAction: row.nextAction,
        updatedAt: toIso(updated.updatedAt),
        exp,
      }),
    };
  }

  async undoTransition(itemId: string, input: unknown, ctx: KernelContext): Promise<ItemDetail> {
    const parsed = UndoItemTransitionInput.parse(input);
    let payload;
    try {
      payload = verifyItemTransitionToken(this.undoSecret, parsed.undoToken);
    } catch {
      throw this.undoMismatch();
    }
    if (
      payload.tenantId !== this.tenantId ||
      payload.itemId !== itemId ||
      payload.actorId !== ctx.actor.id
    ) {
      throw this.undoMismatch();
    }
    if (isTerminalItemStatus(payload.from) || isTerminalItemStatus(payload.to)) {
      throw new KernelError("KERNEL_REJECTED", "已结束的事项不能撤销状态变更", {
        reason: "ITEM_TERMINAL",
      });
    }
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(items)
        .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
        .for("update");
      if (row && isTerminalItemStatus(row.status)) {
        throw new KernelError("KERNEL_REJECTED", "已结束的事项不能撤销状态变更", {
          reason: "ITEM_TERMINAL",
        });
      }
      const [latest] = await tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, this.tenantId),
            eq(auditLog.entityId, itemId),
            inArray(auditLog.action, [
              "ITEM_STATUS_CHANGED",
              "ITEM_STATUS_REVERTED",
              "ITEM_COMPLETED",
            ]),
          ),
        )
        .orderBy(desc(auditLog.seq))
        .limit(1);
      if (
        !row ||
        row.status !== payload.to ||
        toIso(row.updatedAt) !== payload.updatedAt ||
        payload.exp <= Date.now() ||
        latest?.action !== "ITEM_STATUS_CHANGED" ||
        (latest.after as { transitionId?: string } | null)?.transitionId !== payload.transitionId
      ) {
        throw this.undoMismatch();
      }
      const [result] = await tx
        .update(items)
        .set({
          status: payload.from,
          currentStage: payload.currentStage,
          nextAction: payload.nextAction,
          updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
        })
        .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
        .returning();
      if (!result) throw this.undoMismatch();
      await appendAudit(
        tx,
        ctx,
        {
          action: "ITEM_STATUS_REVERTED",
          entityType: "item",
          entityId: itemId,
          before: {
            status: row.status,
            currentStage: row.currentStage,
            nextAction: row.nextAction,
          },
          after: {
            status: result.status,
            currentStage: result.currentStage,
            nextAction: result.nextAction,
            transitionId: payload.transitionId,
          },
        },
        this.tenantId,
      );
      return result;
    });
    return this.detailOf(updated);
  }

  private undoMismatch() {
    return new KernelError("KERNEL_REJECTED", "撤销已过期或事项已更新，请刷新后查看", {
      reason: "ITEM_TRANSITION_UNDO_MISMATCH",
    });
  }

  /**
   * 完成事项：必须有可观察业务结果。
   *
   * P0 的可观察结果 = 本事项下存在一张已确认报价（SENT/ACCEPTED）。
   * 优先按 `quotes.itemId` 精确匹配；只有 WAN-197 之前的老报价（itemId 为空）
   * 才退回「同客户 + 同样品」匹配。已关联到别的事项的报价绝不参与本事项判断，
   * 否则同客户同样品有两条事项时会互相误判完成。
   * 打印结果属于 P0b，届时并列进这一处判断，不回写状态机。
   */
  async complete(itemId: string, ctx: KernelContext): Promise<ItemDetail> {
    const row = await this.requireItem(itemId);
    if (row.status === "COMPLETED") return this.detailOf(row);
    if (row.status === "CLOSED") {
      throw new KernelError("KERNEL_REJECTED", "已关闭的事项不能标记完成", {
        reason: "ITEM_CLOSED",
      });
    }
    if (row.status !== "IN_PROGRESS") {
      throw new KernelError("KERNEL_REJECTED", "请先回到处理中，再标记完成", {
        reason: "ITEM_TRANSITION_INVALID",
      });
    }
    const resultCondition =
      row.customerId && row.sampleId
        ? or(
            eq(quotes.itemId, itemId),
            and(
              isNull(quotes.itemId),
              eq(quotes.customerId, row.customerId),
              eq(quoteItems.sampleId, row.sampleId),
            ),
          )!
        : eq(quotes.itemId, itemId);
    const evidence = await this.db
      .select({ quoteId: quotes.id })
      .from(quoteItems)
      .innerJoin(quotes, eq(quoteItems.quoteId, quotes.id))
      .where(
        and(
          eq(quotes.tenantId, this.tenantId),
          // 现有报价状态机里「确认」落 SENT（D1 定稿动作为 confirm，不引入新状态值）。
          inArray(quotes.status, ["SENT", "ACCEPTED"]),
          resultCondition,
        ),
      )
      .limit(1);
    if (!evidence[0]) {
      throw new KernelError(
        "KERNEL_REJECTED",
        "事项还没有可观察的业务结果（已确认报价），不能标记完成",
        { reason: "ITEM_RESULT_MISSING" },
      );
    }

    const updated = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(items)
        .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
        .for("update");
      if (
        !current ||
        current.status !== row.status ||
        current.updatedAt.getTime() !== row.updatedAt.getTime()
      ) {
        throw this.undoMismatch();
      }
      const next = await tx
        .update(items)
        .set({
          status: "COMPLETED",
          currentStage: STAGE_BY_STATUS.COMPLETED.stage,
          nextAction: STAGE_BY_STATUS.COMPLETED.next,
          updatedAt: new Date(),
        })
        .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
        .returning();
      const result = next[0];
      if (!result) {
        throw new KernelError("RESOURCE_NOT_FOUND", `事项不存在：${itemId}`, {
          resourceType: "item",
          resourceId: itemId,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "ITEM_COMPLETED",
          entityType: "item",
          entityId: itemId,
          before: { status: row.status },
          after: { status: "COMPLETED", evidenceQuoteId: evidence[0]!.quoteId },
        },
        this.tenantId,
      );
      return result;
    });
    return this.detailOf(updated);
  }

  private async requireItem(itemId: string): Promise<ItemRow> {
    const rows = await this.db
      .select()
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `事项不存在：${itemId}`, {
        resourceType: "item",
        resourceId: itemId,
      });
    }
    return row;
  }

  private async requireResource(
    kind: "customer" | "sample",
    id: string,
  ): Promise<{ id: string; code: string; name: string; status: ResourceStatus; unit?: string }> {
    if (kind === "customer") {
      const rows = await this.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.tenantId, this.tenantId)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${id}`, { customerId: id });
      }
      if (row.status === "ARCHIVED") {
        throw new KernelError("KERNEL_REJECTED", "已归档客户不能建事项", {
          reason: "RESOURCE_ARCHIVED",
          resourceType: "customer",
          resourceId: id,
        });
      }
      return row;
    }
    const rows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.id, id), eq(samples.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${id}`, {
        resourceType: "sample",
        resourceId: id,
      });
    }
    if (row.status === "ARCHIVED") {
      throw new KernelError("KERNEL_REJECTED", "已归档样品不能建事项", {
        reason: "RESOURCE_ARCHIVED",
        resourceType: "sample",
        resourceId: id,
      });
    }
    return { ...row, status: row.status === "ACTIVE" ? "AVAILABLE" : row.status };
  }

  private async detailOf(row: ItemRow): Promise<ItemDetail> {
    const [details] = await this.detailsOf([row]);
    return details!;
  }

  /** 批量补齐客户/样品投影：列表页不能出现 N+1 查询。 */
  private async detailsOf(rows: ItemRow[]): Promise<ItemDetail[]> {
    const customerIds = [
      ...new Set(rows.map((row) => row.customerId).filter((id): id is string => !!id)),
    ];
    const sampleIds = [
      ...new Set(rows.map((row) => row.sampleId).filter((id): id is string => !!id)),
    ];
    const [customerRows, sampleRows] = [
      customerIds.length > 0
        ? await this.db
            .select({
              id: customers.id,
              code: customers.code,
              name: customers.name,
              status: customers.status,
            })
            .from(customers)
            .where(and(eq(customers.tenantId, this.tenantId), inArray(customers.id, customerIds)))
        : [],
      sampleIds.length > 0
        ? await this.db
            .select({
              id: samples.id,
              code: samples.code,
              name: samples.name,
              status: samples.status,
            })
            .from(samples)
            .where(and(eq(samples.tenantId, this.tenantId), inArray(samples.id, sampleIds)))
        : [],
    ];
    const customerById = new Map(customerRows.map((row) => [row.id, row]));
    const sampleById = new Map(sampleRows.map((row) => [row.id, row]));
    return rows.map((row) => {
      const customer = row.customerId ? customerById.get(row.customerId) : undefined;
      const sample = row.sampleId ? sampleById.get(row.sampleId) : undefined;
      return ItemDetail.parse({
        item: mapItem(row),
        customer: customer
          ? { id: customer.id, code: customer.code, name: customer.name, status: customer.status }
          : null,
        sample: sample
          ? {
              id: sample.id,
              code: sample.code,
              name: sample.name,
              status: sample.status === "ACTIVE" ? "AVAILABLE" : sample.status,
            }
          : null,
        allowedTransitions: [...ITEM_STATUS_TRANSITIONS[row.status]],
      });
    });
  }
}

/** 非终态条件：完成/关闭的事项不再参与「先查再建」。 */
function notTerminal() {
  return or(
    eq(items.status, "IN_PROGRESS"),
    eq(items.status, "WAITING_INPUT"),
    eq(items.status, "WAITING_DECISION"),
  )!;
}
