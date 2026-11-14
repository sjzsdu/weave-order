import { customers, orderItems, orders, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateOrderInput } from "@weave-order/schema";
import type {
  Order,
  OrderLineItem,
  PricingContext,
  ResolvedPricingValue,
  Unit,
} from "@weave-order/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import type { CustomerService } from "./customers.service";
import { KernelError } from "./errors";
import { ownerScopeFilter } from "./data-scope";
import { milliToQuantity, multiplyCents, quantityToMilli } from "./money";
import { toIso, toIsoOrNull } from "./mappers";
import { priceFloorOf } from "./price-rules";
import { numericValue } from "./pricing.service";
import type { PricingService } from "./pricing.service";

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

function mapOrder(row: OrderRow, items: OrderLineItem[]): Order {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    quoteId: row.quoteId,
    code: row.code,
    status: row.status,
    currency: row.currency,
    items,
    total: { amount: row.totalAmount, currency: row.currency },
    dueDate: toIsoOrNull(row.dueDate),
    progressPct: row.progressPct,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapItem(row: OrderItemRow, currency: Order["currency"]): OrderLineItem {
  return {
    id: row.id,
    sampleId: row.sampleId,
    position: row.position,
    description: row.description,
    quantity: { value: milliToQuantity(row.quantityMilli), unit: row.unit },
    unitPrice: { amount: row.unitPriceAmount, currency },
    lineTotal: { amount: row.lineTotalAmount, currency },
  };
}

/**
 * 订单内核服务：orders / order_items 的唯一写入口。
 *
 * 订单是报价成交后的下一步；金额同样由内核重算，复用报价的成本底线与
 * 最低毛利规则（同样的价格不可能在报价合规、在订单不合规）。
 */
export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly customers: CustomerService,
    private readonly pricing: PricingService,
    private readonly tenantId: string,
  ) {}

  async create(input: unknown, ctx: KernelContext): Promise<Order> {
    const parsed = CreateOrderInput.parse(input);
    // 入口判归属：越权客户按「不存在」返回，与 generateDraft / createDraft 同一口径。
    await this.customers.getById(parsed.customerId, ctx);

    const sampleIds = parsed.items.map((item) => item.sampleId);
    const sampleRows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), inArray(samples.id, sampleIds)));
    const samplesById = new Map(sampleRows.map((row) => [row.id, row]));

    const marginCache = new Map<string, ResolvedPricingValue>();
    const floorCache = new Map<string, ResolvedPricingValue>();
    const lines: Array<{
      sampleId: string;
      position: number;
      description: string;
      quantityMilli: number;
      unit: Unit;
      unitPriceAmount: number;
      lineTotalAmount: number;
    }> = [];
    for (const [index, item] of parsed.items.entries()) {
      const sample = samplesById.get(item.sampleId);
      if (!sample) {
        throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${item.sampleId}`, {
          resourceType: "sample",
          resourceId: item.sampleId,
        });
      }
      if (item.unitPrice.currency !== parsed.currency) {
        throw new KernelError("KERNEL_REJECTED", `第 ${index + 1} 行单价币种与订单币种不一致`, {
          reason: "CURRENCY_MISMATCH",
        });
      }
      if (item.quantity.unit !== sample.unit) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `第 ${index + 1} 行数量单位与样品 ${sample.code} 的单位不一致`,
          { reason: "UNIT_MISMATCH" },
        );
      }
      const category = sample.category ?? "";
      const pricingContext: PricingContext = {
        customerId: parsed.customerId,
        personId: ctx.actor.id,
        ...(category ? { categoryId: category } : {}),
      };
      let margin = marginCache.get(category);
      let floorPolicy = floorCache.get(category);
      // 订单创建是单次动作，策略读取按品类缓存即可。
      if (!margin || !floorPolicy) {
        margin = margin ?? (await this.pricing.resolve("pricing.min_margin_pct", pricingContext));
        floorPolicy =
          floorPolicy ?? (await this.pricing.resolve("pricing.cost_floor_amount", pricingContext));
        marginCache.set(category, margin);
        floorCache.set(category, floorPolicy);
      }
      const floor = priceFloorOf(
        sample,
        parsed.currency,
        numericValue(margin.value) ?? 0,
        numericValue(floorPolicy.value) ?? 0,
      );
      if (floor > 0 && item.unitPrice.amount < floor) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `第 ${index + 1} 行单价低于成本底线/最低毛利：${item.unitPrice.amount} < ${floor}（分）`,
          { reason: "PRICE_BELOW_COST_FLOOR" },
        );
      }
      const quantityMilli = quantityToMilli(item.quantity.value);
      lines.push({
        sampleId: sample.id,
        position: index,
        description: sample.name,
        quantityMilli,
        unit: item.quantity.unit,
        unitPriceAmount: item.unitPrice.amount,
        lineTotalAmount: multiplyCents(item.unitPrice.amount, quantityMilli),
      });
    }
    const totalAmount = lines.reduce((sum, line) => sum + line.lineTotalAmount, 0);

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(orders)
        .values({
          tenantId: this.tenantId,
          customerId: parsed.customerId,
          quoteId: parsed.quoteId ?? null,
          code: parsed.code,
          status: "DRAFT",
          currency: parsed.currency,
          totalAmount,
          dueDate: parsed.dueDate ? new Date(parsed.dueDate) : null,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("KERNEL_REJECTED", "订单写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }
      const inserted = await tx
        .insert(orderItems)
        .values(
          lines.map((line) => ({
            tenantId: this.tenantId,
            orderId: row.id,
            sampleId: line.sampleId,
            position: line.position,
            description: line.description,
            quantityMilli: line.quantityMilli,
            unit: line.unit,
            unitPriceAmount: line.unitPriceAmount,
            lineTotalAmount: line.lineTotalAmount,
          })),
        )
        .returning();
      await appendAudit(
        tx,
        ctx,
        {
          action: "ORDER_CREATED",
          entityType: "order",
          entityId: row.id,
          before: null,
          after: {
            code: row.code,
            customerId: row.customerId,
            totalAmount,
            currency: row.currency,
            lineCount: inserted.length,
          },
        },
        this.tenantId,
      );
      return mapOrder(
        row,
        inserted
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((item) => mapItem(item, row.currency)),
      );
    });
  }

  /** 人工确认订单：DRAFT -> CONFIRMED；智能体无权确认。 */
  async confirm(orderId: string, ctx: KernelContext): Promise<Order> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError("PERMISSION_DENIED", "订单确认必须由人类执行，智能体无权确认");
    }
    // 先按驱动者的数据范围读一次：越权当成不存在，
    // 否则看不见这张单的人也能确认它，响应体还会把整单内容回吐给他。
    const current = await this.getById(orderId, ctx);
    if (current.status !== "DRAFT") {
      throw new KernelError("KERNEL_REJECTED", `订单不是草稿状态：${current.status}`, {
        reason: "INVALID_STATE_TRANSITION",
      });
    }
    const confirmedAt = new Date();
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(orders)
        .set({
          status: "CONFIRMED",
          confirmedBy: ctx.actor.id,
          confirmedAt,
          updatedAt: confirmedAt,
        })
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, this.tenantId)))
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("RESOURCE_NOT_FOUND", `订单不存在：${orderId}`, {
          resourceType: "order",
          resourceId: orderId,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "ORDER_CONFIRMED",
          entityType: "order",
          entityId: orderId,
          before: { status: current.status, totalAmount: current.total.amount },
          after: { status: "CONFIRMED", confirmedBy: ctx.actor.id },
        },
        this.tenantId,
      );
      return mapOrder(row, current.items);
    });
  }

  async getById(orderId: string, ctx?: KernelContext): Promise<Order> {
    // 订单归属随客户：越权时按「不存在」返回，避免枚举他人单据。
    const rows = await this.db
      .select({ order: orders })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.tenantId, this.tenantId),
          ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
        ),
      )
      .limit(1);
    const row = rows[0]?.order;
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `订单不存在：${orderId}`, {
        resourceType: "order",
        resourceId: orderId,
      });
    }
    const itemRows = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.position));
    return mapOrder(
      row,
      itemRows.map((item) => mapItem(item, row.currency)),
    );
  }

  async list(limit = 50, ctx?: KernelContext): Promise<Order[]> {
    const rows = (
      await this.db
        .select({ order: orders })
        .from(orders)
        .innerJoin(customers, eq(customers.id, orders.customerId))
        .where(
          and(
            eq(orders.tenantId, this.tenantId),
            ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(limit)
    ).map((entry) => entry.order);
    if (rows.length === 0) return [];
    const itemRows = await this.db
      .select()
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          rows.map((row) => row.id),
        ),
      );
    const byOrder = new Map<string, OrderItemRow[]>();
    for (const item of itemRows) {
      const list = byOrder.get(item.orderId) ?? [];
      list.push(item);
      byOrder.set(item.orderId, list);
    }
    return rows.map((row) =>
      mapOrder(
        row,
        (byOrder.get(row.id) ?? [])
          .sort((a, b) => a.position - b.position)
          .map((item) => mapItem(item, row.currency)),
      ),
    );
  }
}
