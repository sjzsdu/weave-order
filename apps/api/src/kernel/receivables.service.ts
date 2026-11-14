import { customers, orders, receivables } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateReceivableInput, RecordPaymentInput } from "@weave-order/schema";
import type { Receivable } from "@weave-order/schema";
import { and, desc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import { ownerScopeFilter } from "./data-scope";
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
    // 应收归属随订单的客户：看不见这张订单的人不能给它挂账。
    const orderRows = await this.db
      .select({ order: orders })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          eq(orders.id, parsed.orderId),
          eq(orders.tenantId, this.tenantId),
          ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
        ),
      )
      .limit(1);
    const order = orderRows[0]?.order;
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
    // 锁内按 id + 租户读，够不到「谁该看见这笔账」：先按驱动者的数据范围判一次可见性，
    // 越权当成不存在，否则看不见这笔应收的人也能替它收款。
    await this.getById(parsed.receivableId, ctx);

    return this.db.transaction(async (tx) => {
      // 账本动作必须在锁内读-算-写：并发收款若读在事务外，两笔都会基于同一个
      // paidAmount 写回，后写的那笔会覆盖前一笔（丢账）。FOR UPDATE 让同一笔
      // 应收的收款串行化，第二次读到的就是第一笔提交后的值。
      const lockedRows = await tx
        .select()
        .from(receivables)
        .where(
          and(eq(receivables.id, parsed.receivableId), eq(receivables.tenantId, this.tenantId)),
        )
        .limit(1)
        .for("update");
      const current = lockedRows[0];
      if (!current) {
        throw new KernelError("RESOURCE_NOT_FOUND", `应收不存在：${parsed.receivableId}`, {
          resourceType: "receivable",
          resourceId: parsed.receivableId,
        });
      }
      if (current.status === "PAID" || current.status === "CANCELLED") {
        throw new KernelError("KERNEL_REJECTED", `应收状态 ${current.status} 不能收款`, {
          reason: "INVALID_STATE_TRANSITION",
        });
      }
      if (parsed.amount.currency !== current.currency) {
        throw new KernelError("KERNEL_REJECTED", "收款币种与应收币种不一致", {
          reason: "CURRENCY_MISMATCH",
        });
      }
      const remaining = current.amount - current.paidAmount;
      if (parsed.amount.amount > remaining) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `收款金额超过未收余额：${parsed.amount.amount} > ${remaining}（分）`,
          { reason: "PAYMENT_EXCEEDS_REMAINING" },
        );
      }
      const paidAmount = current.paidAmount + parsed.amount.amount;
      const status = paidAmount === current.amount ? "PAID" : "PARTIAL";
      const paidAt =
        status === "PAID" ? (parsed.paidAt ? new Date(parsed.paidAt) : new Date()) : null;

      // 乐观条件作为第二道闸：即使将来有人去掉 FOR UPDATE，命中 0 行也不会覆盖账本。
      const rows = await tx
        .update(receivables)
        .set({ paidAmount, status, paidAt, updatedAt: new Date() })
        .where(
          and(
            eq(receivables.id, parsed.receivableId),
            eq(receivables.tenantId, this.tenantId),
            eq(receivables.paidAmount, current.paidAmount),
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("KERNEL_REJECTED", "应收已发生变化，请重试本次收款", {
          reason: "VERSION_CONFLICT",
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "RECEIVABLE_PAYMENT_RECORDED",
          entityType: "receivable",
          entityId: row.id,
          before: { paidAmount: current.paidAmount, status: current.status },
          after: { paidAmount: row.paidAmount, status: row.status, amount: row.amount },
        },
        this.tenantId,
      );
      return mapReceivable(row);
    });
  }

  async getById(receivableId: string, ctx?: KernelContext): Promise<Receivable> {
    // 应收归属随客户：越权时按「不存在」返回。
    const rows = await this.db
      .select({ receivable: receivables })
      .from(receivables)
      .innerJoin(customers, eq(customers.id, receivables.customerId))
      .where(
        and(
          eq(receivables.id, receivableId),
          eq(receivables.tenantId, this.tenantId),
          ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
        ),
      )
      .limit(1);
    const row = rows[0]?.receivable;
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `应收不存在：${receivableId}`, {
        resourceType: "receivable",
        resourceId: receivableId,
      });
    }
    return mapReceivable(row);
  }

  async list(limit = 50, ctx?: KernelContext): Promise<Receivable[]> {
    const rows = (
      await this.db
        .select({ receivable: receivables })
        .from(receivables)
        .innerJoin(customers, eq(customers.id, receivables.customerId))
        .where(
          and(
            eq(receivables.tenantId, this.tenantId),
            ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
          ),
        )
        .orderBy(desc(receivables.createdAt))
        .limit(limit)
    ).map((entry) => entry.receivable);
    return rows.map(mapReceivable);
  }
}
