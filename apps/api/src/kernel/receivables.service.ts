import { orders, receivables } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateReceivableInput, RecordPaymentInput } from "@weave-order/schema";
import type { Receivable } from "@weave-order/schema";
import { and, desc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import { toIso, toIsoOrNull } from "./mappers";

type ReceivableRow = typeof receivables.$inferSelect;

function mapReceivable(row: ReceivableRow): Receivable {
  return {
    id: row.id,
    tenantId: row.tenantId,
    orderId: row.orderId,
    customerId: row.customerId,
    amount: { amount: row.amount, currency: row.currency },
    paidAmount: { amount: row.paidAmount, currency: row.currency },
    dueDate: toIso(row.dueDate),
    status: row.status,
    paidAt: toIsoOrNull(row.paidAt),
    createdAt: toIso(row.createdAt),
  };
}

/**
 * 应收内核服务：receivables 的唯一写入口。
 *
 * 收款是账本动作，必须由 HUMAN 执行；金额整数分，部分收款累加 paidAmount，
 * 状态由内核按「已收 vs 应收」推导，不接受调用方指定。
 */
export class ReceivableService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async create(input: unknown, ctx: KernelContext): Promise<Receivable> {
    const parsed = CreateReceivableInput.parse(input);
    const orderRows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, parsed.orderId), eq(orders.tenantId, this.tenantId)))
      .limit(1);
    const order = orderRows[0];
    if (!order) {
      throw new KernelError("RESOURCE_NOT_FOUND", `订单不存在：${parsed.orderId}`, {
        resourceType: "order",
        resourceId: parsed.orderId,
      });
    }
    if (order.status === "DRAFT" || order.status === "CANCELLED") {
      throw new KernelError("KERNEL_REJECTED", `订单状态 ${order.status} 不能建应收`, {
        reason: "INVALID_STATE_TRANSITION",
      });
    }
    if (parsed.amount.currency !== order.currency) {
      throw new KernelError("KERNEL_REJECTED", "应收币种与订单币种不一致", {
        reason: "CURRENCY_MISMATCH",
      });
    }
    if (parsed.amount.amount > order.totalAmount) {
      throw new KernelError("KERNEL_REJECTED", "应收金额不能超过订单总额", {
        reason: "RECEIVABLE_EXCEEDS_ORDER_TOTAL",
      });
    }

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(receivables)
        .values({
          tenantId: this.tenantId,
          orderId: order.id,
          customerId: order.customerId,
          amount: parsed.amount.amount,
          paidAmount: 0,
          currency: order.currency,
          dueDate: new Date(parsed.dueDate),
          status: "PENDING",
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("KERNEL_REJECTED", "应收写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "RECEIVABLE_CREATED",
          entityType: "receivable",
          entityId: row.id,
          before: null,
          after: {
            orderId: row.orderId,
            amount: row.amount,
            currency: row.currency,
            dueDate: toIso(row.dueDate),
          },
        },
        this.tenantId,
      );
      return mapReceivable(row);
    });
  }

  /** 记录收款：部分收款 -> PARTIAL，收满 -> PAID；超额与币种不符一律拒绝。 */
  async recordPayment(input: unknown, ctx: KernelContext): Promise<Receivable> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError("PERMISSION_DENIED", "收款必须由人类确认，智能体无权记账");
    }
    const parsed = RecordPaymentInput.parse(input);
    const current = await this.getById(parsed.receivableId);
    if (current.status === "PAID" || current.status === "CANCELLED") {
      throw new KernelError("KERNEL_REJECTED", `应收状态 ${current.status} 不能收款`, {
        reason: "INVALID_STATE_TRANSITION",
      });
    }
    if (parsed.amount.currency !== current.amount.currency) {
      throw new KernelError("KERNEL_REJECTED", "收款币种与应收币种不一致", {
        reason: "CURRENCY_MISMATCH",
      });
    }
    const remaining = current.amount.amount - current.paidAmount.amount;
    if (parsed.amount.amount > remaining) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `收款金额超过未收余额：${parsed.amount.amount} > ${remaining}（分）`,
        { reason: "PAYMENT_EXCEEDS_REMAINING" },
      );
    }
    const paidAmount = current.paidAmount.amount + parsed.amount.amount;
    const status = paidAmount === current.amount.amount ? "PAID" : "PARTIAL";
    const paidAt =
      status === "PAID" ? (parsed.paidAt ? new Date(parsed.paidAt) : new Date()) : null;

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(receivables)
        .set({ paidAmount, status, paidAt, updatedAt: new Date() })
        .where(
          and(eq(receivables.id, parsed.receivableId), eq(receivables.tenantId, this.tenantId)),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("RESOURCE_NOT_FOUND", `应收不存在：${parsed.receivableId}`, {
          resourceType: "receivable",
          resourceId: parsed.receivableId,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "RECEIVABLE_PAYMENT_RECORDED",
          entityType: "receivable",
          entityId: row.id,
          before: { paidAmount: current.paidAmount.amount, status: current.status },
          after: { paidAmount: row.paidAmount, status: row.status, amount: row.amount },
        },
        this.tenantId,
      );
      return mapReceivable(row);
    });
  }

  async getById(receivableId: string): Promise<Receivable> {
    const rows = await this.db
      .select()
      .from(receivables)
      .where(and(eq(receivables.id, receivableId), eq(receivables.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `应收不存在：${receivableId}`, {
        resourceType: "receivable",
        resourceId: receivableId,
      });
    }
    return mapReceivable(row);
  }

  async list(limit = 50): Promise<Receivable[]> {
    const rows = await this.db
      .select()
      .from(receivables)
      .where(eq(receivables.tenantId, this.tenantId))
      .orderBy(desc(receivables.createdAt))
      .limit(limit);
    return rows.map(mapReceivable);
  }
}
