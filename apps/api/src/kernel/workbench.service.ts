import {
  auditLog,
  customers,
  orderItems,
  orderShipmentItems,
  orderShipments,
  orders,
  quotes,
  receivablePayments,
  receivables,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type {
  Currency,
  OrderFunnel,
  OrderFunnelStage,
  OrderListResponse,
  OrderStatus,
  OrderWorkbench,
  ReceivableBucket,
  ReceivableListResponse,
  ReceivableStatement,
  ReceivableStatus,
} from "@weave-order/schema";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { KernelContext } from "./audit";
import { decodeCursor, encodeCursor, invalidCursor } from "./cursor";
import { ownerScopeFilter } from "./data-scope";
import type { CustomerService } from "./customers.service";
import type { OrderShipmentService } from "./order-shipments.service";
import type { OrderService } from "./orders.service";
import { mapReceivable } from "./receivables.service";
import type { ReceivableService } from "./receivables.service";
import type { ShipmentService } from "./shipments.service";
import { toIso, toIsoOrNull } from "./mappers";

/**
 * 订单 / 应收工作面（读模型）。
 *
 * 与写内核的分工：这里从不写库，只把「列表页 + 详情页」一次需要的
 * 字段聚合好。逾期、已发未发、余额全部在此派生，前端不重复算，
 * 也就不会出现「页面 12 条、点进去 13 条」。
 */

export interface OrderListFilters {
  statuses?: OrderStatus[];
  customerId?: string;
  dueFrom?: Date;
  dueBefore?: Date;
  overdueOnly?: boolean;
}

export interface OrderListRequest extends OrderListFilters {
  cursor?: string | null;
  limit: number;
}

export interface ReceivableListRequest {
  bucket: ReceivableBucket;
  customerId?: string;
  cursor?: string | null;
  limit: number;
}

export interface StatementRange {
  from?: Date;
  to?: Date;
}

const OVERDUE_EXCLUDED_STATUSES: OrderStatus[] = ["COMPLETED", "CANCELLED"];

const FUNNEL_STAGES: Array<Omit<OrderFunnelStage, "count">> = [
  // 这一段是订单草稿（报价草稿成交前的待确认单），不是报价单本身：
  // 报价没有列表工作面，标签写清楚，避免和「报价」概念混淆。
  { key: "DRAFT", label: "草稿/待确认", statuses: ["DRAFT"] },
  { key: "CONFIRMED", label: "已成交", statuses: ["CONFIRMED"] },
  { key: "IN_PRODUCTION", label: "生产中", statuses: ["IN_PRODUCTION"] },
  { key: "SHIPPED", label: "已发货", statuses: ["SHIPPED", "COMPLETED"] },
];

function overdueCondition(now: Date): SQL | undefined {
  return and(lt(orders.dueDate, now), sql`${orders.status} NOT IN ('COMPLETED','CANCELLED')`);
}

function endOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function parseOrderCursor(
  raw: string | null | undefined,
): { dueAt: Date | null; id: string } | null {
  const parsed = decodeCursor(raw);
  if (!parsed) return null;
  const { d, i } = parsed;
  if (i === undefined || typeof i !== "string" || i.length === 0) throw invalidCursor();
  if (d === null) return { dueAt: null, id: i };
  if (typeof d !== "string" || Number.isNaN(Date.parse(d))) throw invalidCursor();
  return { dueAt: new Date(d), id: i };
}

export class WorkbenchService {
  constructor(
    private readonly db: Db,
    private readonly orders: OrderService,
    private readonly customers: CustomerService,
    private readonly orderShipments: OrderShipmentService,
    private readonly shipments: ShipmentService,
    private readonly receivableService: ReceivableService,
    private readonly tenantId: string,
  ) {}

  /** 订单列表：交期升序（最急在前），空的交期排最后。 */
  async listOrders(request: OrderListRequest, ctx?: KernelContext): Promise<OrderListResponse> {
    const now = new Date();
    const base: SQL[] = [eq(orders.tenantId, this.tenantId)];
    const scope = ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId);
    if (scope) base.push(scope);
    if (request.statuses && request.statuses.length > 0) {
      base.push(inArray(orders.status, request.statuses));
    }
    if (request.customerId) base.push(eq(orders.customerId, request.customerId));
    if (request.dueFrom) base.push(gte(orders.dueDate, request.dueFrom));
    if (request.dueBefore) base.push(lte(orders.dueDate, request.dueBefore));
    if (request.overdueOnly) {
      const overdue = overdueCondition(now);
      if (overdue) base.push(overdue);
    }

    const conditions = [...base];
    const cursor = parseOrderCursor(request.cursor);
    if (cursor) {
      conditions.push(cursorCondition(cursor));
    }

    const rows = await this.db
      .select({ order: orders, customerName: customers.name, customerCode: customers.code })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(...conditions))
      .orderBy(sql`${orders.dueDate} ASC NULLS LAST`, asc(orders.id))
      .limit(request.limit + 1);

    const page = rows.slice(0, request.limit);
    const hasMore = rows.length > request.limit;
    const ids = page.map((row) => row.order.id);

    const [itemRows, shippedRows, auditRows, totalRows] = await Promise.all([
      ids.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              orderId: orderItems.orderId,
              id: orderItems.id,
              quantityMilli: orderItems.quantityMilli,
            })
            .from(orderItems)
            .where(and(eq(orderItems.tenantId, this.tenantId), inArray(orderItems.orderId, ids))),
      ids.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              orderId: orderShipments.orderId,
              orderItemId: orderShipmentItems.orderItemId,
              quantityMilli: orderShipmentItems.quantityMilli,
            })
            .from(orderShipmentItems)
            .innerJoin(orderShipments, eq(orderShipments.id, orderShipmentItems.shipmentId))
            .where(
              and(
                eq(orderShipmentItems.tenantId, this.tenantId),
                inArray(orderShipments.orderId, ids),
                ne(orderShipments.status, "CANCELLED"),
              ),
            ),
      ids.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              entityId: auditLog.entityId,
              action: auditLog.action,
              actorType: auditLog.actorType,
              createdAt: auditLog.createdAt,
            })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.tenantId, this.tenantId),
                eq(auditLog.entityType, "order"),
                inArray(auditLog.entityId, ids),
              ),
            )
            .orderBy(desc(auditLog.seq)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .innerJoin(customers, eq(customers.id, orders.customerId))
        .where(and(...base)),
    ]);

    const linesByOrder = new Map<string, Array<{ id: string; quantityMilli: number }>>();
    for (const item of itemRows) {
      const bucket = linesByOrder.get(item.orderId) ?? [];
      bucket.push({ id: item.id, quantityMilli: item.quantityMilli });
      linesByOrder.set(item.orderId, bucket);
    }
    const shippedByLine = new Map<string, number>();
    for (const shipped of shippedRows) {
      shippedByLine.set(
        shipped.orderItemId,
        (shippedByLine.get(shipped.orderItemId) ?? 0) + shipped.quantityMilli,
      );
    }
    const lastActionByOrder = new Map<string, { action: string; actorType: string; at: string }>();
    for (const entry of auditRows) {
      if (!lastActionByOrder.has(entry.entityId)) {
        lastActionByOrder.set(entry.entityId, {
          action: entry.action,
          actorType: entry.actorType,
          at: toIso(entry.createdAt),
        });
      }
    }

    const last = page[page.length - 1];
    return {
      orders: page.map(({ order, customerName, customerCode }) => {
        const lines = linesByOrder.get(order.id) ?? [];
        const shippedLineCount = lines.filter(
          (line) => (shippedByLine.get(line.id) ?? 0) >= line.quantityMilli,
        ).length;
        const dueDate = toIsoOrNull(order.dueDate);
        return {
          id: order.id,
          code: order.code,
          customerId: order.customerId,
          customerName,
          customerCode,
          status: order.status,
          currency: order.currency,
          total: { amount: order.totalAmount, currency: order.currency },
          dueDate,
          itemCount: lines.length,
          shippedLineCount,
          overdue:
            dueDate !== null && order.dueDate !== null
              ? order.dueDate.getTime() < now.getTime() &&
                !OVERDUE_EXCLUDED_STATUSES.includes(order.status)
              : false,
          lastAction: lastActionByOrder.get(order.id) ?? null,
          createdAt: toIso(order.createdAt),
          updatedAt: toIso(order.updatedAt),
        };
      }),
      total: totalRows[0]?.count ?? 0,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ d: toIsoOrNull(last.order.dueDate), i: last.order.id })
          : null,
    };
  }

  /** 漏斗：与列表同一套（非状态）筛选，点数字进去正好等于该阶段条数。 */
  async orderFunnel(filters: OrderListFilters, ctx?: KernelContext): Promise<OrderFunnel> {
    const now = new Date();
    const conditions: SQL[] = [eq(orders.tenantId, this.tenantId)];
    const scope = ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId);
    if (scope) conditions.push(scope);
    if (filters.customerId) conditions.push(eq(orders.customerId, filters.customerId));
    if (filters.dueFrom) conditions.push(gte(orders.dueDate, filters.dueFrom));
    if (filters.dueBefore) conditions.push(lte(orders.dueDate, filters.dueBefore));
    if (filters.overdueOnly) {
      const overdue = overdueCondition(now);
      if (overdue) conditions.push(overdue);
    }

    const rows = await this.db
      .select({ status: orders.status, count: sql<number>`count(*)::int` })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(...conditions))
      .groupBy(orders.status);
    const counts = new Map(rows.map((row) => [row.status, row.count]));

    return {
      stages: FUNNEL_STAGES.map((stage) => ({
        ...stage,
        count: stage.statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0),
      })),
      generatedAt: toIso(now),
    };
  }

  /** 订单详情：行项目 / 关联报价 / 寄样记录 / 发货记录一次读全。 */
  async orderWorkbench(orderId: string, ctx?: KernelContext): Promise<OrderWorkbench> {
    const order = await this.orders.getById(orderId, ctx);
    const [customer, shipments, sampleShipments] = await Promise.all([
      this.customers.getById(order.customerId, ctx),
      this.orderShipments.listByOrder(orderId),
      this.shipments.listByCustomer(order.customerId, 5, ctx),
    ]);

    let quote: OrderWorkbench["quote"] = null;
    if (order.quoteId) {
      const quoteRows = await this.db
        .select({
          id: quotes.id,
          status: quotes.status,
          currency: quotes.currency,
          totalAmount: quotes.totalAmount,
          createdAt: quotes.createdAt,
        })
        .from(quotes)
        .where(and(eq(quotes.id, order.quoteId), eq(quotes.tenantId, this.tenantId)))
        .limit(1);
      const row = quoteRows[0];
      if (row) {
        quote = {
          id: row.id,
          status: row.status,
          total: { amount: row.totalAmount, currency: row.currency },
          createdAt: toIso(row.createdAt),
        };
      }
    }

    return { order, customer, quote, shipments, sampleShipments };
  }

  /** 应收列表：逾期 / 本月到期 / 已结清，按到期日升序。 */
  async listReceivables(
    request: ReceivableListRequest,
    ctx?: KernelContext,
  ): Promise<ReceivableListResponse> {
    const now = new Date();
    const monthEnd = endOfMonth(now);
    const base: SQL[] = [eq(receivables.tenantId, this.tenantId)];
    const scope = ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId);
    if (scope) base.push(scope);
    if (request.customerId) base.push(eq(receivables.customerId, request.customerId));

    const conditions = [...base];
    const bucketCondition = receivableBucketCondition(request.bucket, now, monthEnd);
    if (bucketCondition) conditions.push(bucketCondition);

    const cursor = decodeCursor(request.cursor);
    if (cursor) {
      const { d, i } = cursor;
      if (typeof i !== "string" || typeof d !== "string" || Number.isNaN(Date.parse(d))) {
        throw invalidCursor();
      }
      conditions.push(cursorReceivableCondition(new Date(d), i));
    }

    const rows = await this.db
      .select({
        receivable: receivables,
        customerName: customers.name,
        customerCode: customers.code,
        orderCode: orders.code,
      })
      .from(receivables)
      .innerJoin(customers, eq(customers.id, receivables.customerId))
      .innerJoin(orders, eq(orders.id, receivables.orderId))
      .where(and(...conditions))
      .orderBy(asc(receivables.dueDate), asc(receivables.id))
      .limit(request.limit + 1);

    const page = rows.slice(0, request.limit);
    const ids = page.map((row) => row.receivable.id);
    const paymentAggregates =
      ids.length === 0 ? new Map<string, Date>() : await this.lastPaymentByReceivable(ids);

    const [counts, balances] = await Promise.all([
      this.db
        .select({
          overdue: sql<number>`count(*) filter (where ${receivables.status} not in ('PAID','CANCELLED') and ${receivables.dueDate} < ${now})::int`,
          dueSoon: sql<number>`count(*) filter (where ${receivables.status} not in ('PAID','CANCELLED') and ${receivables.dueDate} >= ${now} and ${receivables.dueDate} < ${monthEnd})::int`,
          settled: sql<number>`count(*) filter (where ${receivables.status} = 'PAID')::int`,
        })
        .from(receivables)
        .innerJoin(customers, eq(customers.id, receivables.customerId))
        .where(and(...base)),
      this.db
        .select({
          currency: receivables.currency,
          amount: sql<number>`coalesce(sum(${receivables.amount} - ${receivables.paidAmount}), 0)::bigint`,
        })
        .from(receivables)
        .innerJoin(customers, eq(customers.id, receivables.customerId))
        .where(and(...base, sql`${receivables.status} NOT IN ('PAID','CANCELLED')`))
        .groupBy(receivables.currency),
    ]);

    const last = page[page.length - 1];
    return {
      receivables: page.map(({ receivable, customerName, customerCode, orderCode }) => {
        const status = deriveReceivableStatus(receivable.status, receivable.dueDate, now);
        const lastPayment = paymentAggregates.get(receivable.id);
        return {
          id: receivable.id,
          orderId: receivable.orderId,
          orderCode,
          customerId: receivable.customerId,
          customerName,
          customerCode,
          amount: { amount: receivable.amount, currency: receivable.currency },
          paidAmount: { amount: receivable.paidAmount, currency: receivable.currency },
          balance: {
            amount: receivable.amount - receivable.paidAmount,
            currency: receivable.currency,
          },
          status,
          dueDate: toIso(receivable.dueDate),
          daysOverdue: daysBetween(receivable.dueDate, now),
          lastPaymentAt: lastPayment ? toIso(lastPayment) : null,
          createdAt: toIso(receivable.createdAt),
        };
      }),
      hasMore: rows.length > request.limit,
      nextCursor:
        rows.length > request.limit && last
          ? encodeCursor({ d: toIso(last.receivable.dueDate), i: last.receivable.id })
          : null,
      summary: {
        overdue: counts[0]?.overdue ?? 0,
        dueSoon: counts[0]?.dueSoon ?? 0,
        settled: counts[0]?.settled ?? 0,
        balanceByCurrency: balances.map((row) => ({
          currency: row.currency,
          amount: Number(row.amount),
        })),
      },
    };
  }

  /**
   * 客户对账单：一笔应收一行、一笔回款一行，全部来自账本。
   * `proofUrl` 通过注入的签名函数生成，内核本身不碰对象存储。
   */
  async customerStatement(
    customerId: string,
    range: StatementRange,
    proofUrl: (objectKey: string) => Promise<string | null>,
    ctx?: KernelContext,
  ): Promise<ReceivableStatement> {
    const customer = await this.customers.getById(customerId, ctx);
    const conditions: SQL[] = [
      eq(receivables.tenantId, this.tenantId),
      eq(receivables.customerId, customerId),
      ne(receivables.status, "CANCELLED"),
    ];
    const scope = ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId);
    if (scope) conditions.push(scope);
    if (range.from) conditions.push(gte(receivables.dueDate, range.from));
    if (range.to) conditions.push(lte(receivables.dueDate, range.to));

    const rows = await this.db
      .select({ receivable: receivables, orderCode: orders.code })
      .from(receivables)
      .innerJoin(orders, eq(orders.id, receivables.orderId))
      .where(and(...conditions))
      .orderBy(asc(receivables.dueDate), asc(receivables.id));

    const paymentsByReceivable = await this.receivableService.listPaymentsFor(
      rows.map((row) => row.receivable.id),
    );
    // 凭证 URL 一次并发签完：逐行 await 会把「N 笔回款」变成 N 次串行往返。
    const proofUrls = new Map<string, string | null>();
    await Promise.all(
      Array.from(paymentsByReceivable.values())
        .flat()
        .flatMap((payment) =>
          payment.proofObjectKey ? [{ id: payment.id, key: payment.proofObjectKey }] : [],
        )
        .map(async ({ id, key }) => {
          proofUrls.set(id, await proofUrl(key));
        }),
    );

    const totals = new Map<Currency, { amount: number; paid: number; balance: number }>();
    const legacy = new Map<Currency, number>();
    const lines: ReceivableStatement["lines"] = [];
    for (const { receivable, orderCode } of rows) {
      const payments = paymentsByReceivable.get(receivable.id) ?? [];
      const ledgerPaid = payments.reduce((sum, payment) => sum + payment.amount.amount, 0);
      const legacyPaid = Math.max(0, receivable.paidAmount - ledgerPaid);
      if (legacyPaid > 0) {
        legacy.set(receivable.currency, (legacy.get(receivable.currency) ?? 0) + legacyPaid);
      }
      const bucket = totals.get(receivable.currency) ?? { amount: 0, paid: 0, balance: 0 };
      bucket.amount += receivable.amount;
      bucket.paid += receivable.paidAmount;
      bucket.balance += receivable.amount - receivable.paidAmount;
      totals.set(receivable.currency, bucket);

      lines.push({
        receivable: mapReceivable(receivable),
        orderCode,
        payments: payments.map((payment) => ({
          id: payment.id,
          receivableId: payment.receivableId,
          amount: payment.amount,
          paidAt: payment.paidAt,
          note: payment.note,
          proofUrl: proofUrls.get(payment.id) ?? null,
          createdAt: payment.createdAt,
        })),
      });
    }

    return {
      customer,
      from: range.from ? toIso(range.from) : null,
      to: range.to ? toIso(range.to) : null,
      lines,
      totalsByCurrency: Array.from(totals.entries()).map(([currency, value]) => ({
        currency,
        ...value,
      })),
      legacyPaidByCurrency: Array.from(legacy.entries()).map(([currency, amount]) => ({
        currency,
        amount,
      })),
      generatedAt: toIso(new Date()),
    };
  }

  private async lastPaymentByReceivable(ids: string[]): Promise<Map<string, Date>> {
    const rows = await this.db
      .select({
        receivableId: receivables.id,
        lastPaidAt: sql<Date | null>`max(${receivablePayments.paidAt})`,
      })
      .from(receivables)
      .leftJoin(
        receivablePayments,
        and(
          eq(receivablePayments.receivableId, receivables.id),
          eq(receivablePayments.tenantId, this.tenantId),
        ),
      )
      .where(and(eq(receivables.tenantId, this.tenantId), inArray(receivables.id, ids)))
      .groupBy(receivables.id);
    const map = new Map<string, Date>();
    for (const row of rows) {
      if (row.lastPaidAt) map.set(row.receivableId, new Date(row.lastPaidAt));
    }
    return map;
  }
}

function cursorCondition(cursor: { dueAt: Date | null; id: string }): SQL {
  if (!cursor.dueAt) {
    return and(isNull(orders.dueDate), gt(orders.id, cursor.id))!;
  }
  return or(
    gt(orders.dueDate, cursor.dueAt),
    and(eq(orders.dueDate, cursor.dueAt), gt(orders.id, cursor.id)),
    isNull(orders.dueDate),
  )!;
}

function cursorReceivableCondition(dueAt: Date, id: string): SQL {
  return or(
    gt(receivables.dueDate, dueAt),
    and(eq(receivables.dueDate, dueAt), gt(receivables.id, id)),
  )!;
}

function receivableBucketCondition(
  bucket: ReceivableBucket,
  now: Date,
  monthEnd: Date,
): SQL | undefined {
  if (bucket === "overdue") {
    return and(
      sql`${receivables.status} NOT IN ('PAID','CANCELLED')`,
      lt(receivables.dueDate, now),
    );
  }
  if (bucket === "dueSoon") {
    return and(
      sql`${receivables.status} NOT IN ('PAID','CANCELLED')`,
      gte(receivables.dueDate, now),
      lt(receivables.dueDate, monthEnd),
    );
  }
  if (bucket === "settled") return eq(receivables.status, "PAID");
  return undefined;
}

function deriveReceivableStatus(
  status: ReceivableStatus,
  dueDate: Date,
  now: Date,
): ReceivableStatus {
  if (status === "PAID" || status === "CANCELLED") return status;
  if (dueDate.getTime() < now.getTime()) return "OVERDUE";
  return status;
}

function daysBetween(dueDate: Date, now: Date): number {
  const diff = now.getTime() - dueDate.getTime();
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000);
}
