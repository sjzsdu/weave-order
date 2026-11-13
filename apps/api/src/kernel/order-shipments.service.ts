import { orderItems, orderShipmentItems, orderShipments, orders } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateShipmentInput } from "@weave-order/schema";
import type { Shipment, ShipmentLineItem } from "@weave-order/schema";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import { milliToQuantity, quantityToMilli } from "./money";
import { toIso, toIsoOrNull } from "./mappers";

type ShipmentRow = typeof orderShipments.$inferSelect;
type ShipmentItemRow = typeof orderShipmentItems.$inferSelect;

/** 发货单号由 ID 派生：不需要额外序列，也不会因为并发插入而重复。 */
export function shipmentNo(shipmentId: string): string {
  return `SH-${shipmentId.slice(0, 8).toUpperCase()}`;
}

function mapShipment(row: ShipmentRow, items: ShipmentLineItem[]): Shipment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    orderId: row.orderId,
    status: row.status,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    address: row.address,
    items,
    shippedAt: toIsoOrNull(row.shippedAt),
    deliveredAt: toIsoOrNull(row.deliveredAt),
    createdAt: toIso(row.createdAt),
  };
}

/**
 * 订单发货单内核服务（非寄样）。
 *
 * 关键约束：同一订单行的累计发货量不得超过订购量（取消的发货单不计），
 * 因此「先超发再对账」在数据层就不可能发生。
 */
export class OrderShipmentService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async create(input: unknown, ctx: KernelContext): Promise<Shipment> {
    const parsed = CreateShipmentInput.parse(input);
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
      throw new KernelError("KERNEL_REJECTED", `订单状态不允许发货：${order.status}`, {
        reason: "INVALID_STATE_TRANSITION",
      });
    }

    const lineRows = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    const linesById = new Map(lineRows.map((line) => [line.id, line]));
    const requested = new Map<string, number>();
    for (const item of parsed.items) {
      const line = linesById.get(item.orderItemId);
      if (!line) {
        throw new KernelError("RESOURCE_NOT_FOUND", `订单行不存在：${item.orderItemId}`, {
          resourceType: "order_item",
          resourceId: item.orderItemId,
        });
      }
      if (line.unit !== item.quantity.unit) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `数量单位与订单行不一致：订单行 ${line.id} 为 ${line.unit}`,
          { reason: "UNIT_MISMATCH" },
        );
      }
      requested.set(
        item.orderItemId,
        (requested.get(item.orderItemId) ?? 0) + quantityToMilli(item.quantity.value),
      );
    }

    // 已发货量（不含取消/已删除）
    const existing = await this.db
      .select({
        orderItemId: orderShipmentItems.orderItemId,
        quantityMilli: orderShipmentItems.quantityMilli,
      })
      .from(orderShipmentItems)
      .innerJoin(orderShipments, eq(orderShipments.id, orderShipmentItems.shipmentId))
      .where(
        and(
          eq(orderShipmentItems.tenantId, this.tenantId),
          eq(orderShipments.orderId, order.id),
          ne(orderShipments.status, "CANCELLED"),
        ),
      );
    const shipped = new Map<string, number>();
    for (const row of existing) {
      shipped.set(row.orderItemId, (shipped.get(row.orderItemId) ?? 0) + row.quantityMilli);
    }
    for (const [orderItemId, add] of requested) {
      const line = linesById.get(orderItemId)!;
      const next = (shipped.get(orderItemId) ?? 0) + add;
      if (next > line.quantityMilli) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `发货数量超过订单数量：订单行 ${line.description} 订购 ${milliToQuantity(line.quantityMilli)}，` +
            `已发 ${milliToQuantity(shipped.get(orderItemId) ?? 0)}，本次 ${milliToQuantity(add)}`,
          { reason: "QUANTITY_EXCEEDED" },
        );
      }
    }

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(orderShipments)
        .values({
          tenantId: this.tenantId,
          orderId: order.id,
          status: "DRAFT",
          carrier: parsed.carrier ?? null,
          trackingNumber: parsed.trackingNumber ?? null,
          address: parsed.address ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("KERNEL_REJECTED", "发货单写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }
      const inserted = await tx
        .insert(orderShipmentItems)
        .values(
          parsed.items.map((item) => ({
            tenantId: this.tenantId,
            shipmentId: row.id,
            orderItemId: item.orderItemId,
            quantityMilli: quantityToMilli(item.quantity.value),
            unit: item.quantity.unit,
          })),
        )
        .returning();

      await appendAudit(
        tx,
        ctx,
        {
          action: "SHIPMENT_CREATED",
          entityType: "order_shipment",
          entityId: row.id,
          before: null,
          after: {
            orderId: order.id,
            orderNo: order.code,
            itemCount: inserted.length,
          },
        },
        this.tenantId,
      );

      return mapShipment(
        row,
        inserted.map((item) => ({
          id: item.id,
          orderItemId: item.orderItemId,
          quantity: { value: milliToQuantity(item.quantityMilli), unit: item.unit },
        })),
      );
    });
  }

  async getById(shipmentId: string): Promise<Shipment> {
    const rows = await this.db
      .select()
      .from(orderShipments)
      .where(and(eq(orderShipments.id, shipmentId), eq(orderShipments.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `发货单不存在：${shipmentId}`, {
        resourceType: "order_shipment",
        resourceId: shipmentId,
      });
    }
    const items = await this.db
      .select()
      .from(orderShipmentItems)
      .where(eq(orderShipmentItems.shipmentId, shipmentId))
      .orderBy(asc(orderShipmentItems.id));
    return mapShipment(
      row,
      items.map((item) => ({
        id: item.id,
        orderItemId: item.orderItemId,
        quantity: { value: milliToQuantity(item.quantityMilli), unit: item.unit },
      })),
    );
  }

  async listByOrder(orderId: string): Promise<Shipment[]> {
    const rows = await this.db
      .select()
      .from(orderShipments)
      .where(and(eq(orderShipments.orderId, orderId), eq(orderShipments.tenantId, this.tenantId)));
    if (rows.length === 0) return [];
    const items = await this.db
      .select()
      .from(orderShipmentItems)
      .where(
        inArray(
          orderShipmentItems.shipmentId,
          rows.map((row) => row.id),
        ),
      );
    const byShipment = new Map<string, ShipmentItemRow[]>();
    for (const item of items) {
      const list = byShipment.get(item.shipmentId) ?? [];
      list.push(item);
      byShipment.set(item.shipmentId, list);
    }
    return rows.map((row) =>
      mapShipment(
        row,
        (byShipment.get(row.id) ?? []).map((item) => ({
          id: item.id,
          orderItemId: item.orderItemId,
          quantity: { value: milliToQuantity(item.quantityMilli), unit: item.unit },
        })),
      ),
    );
  }

  /** 确认发货：DRAFT/PACKED -> SHIPPED，同时把订单推进到 SHIPPED。 */
  async markShipped(shipmentId: string, ctx: KernelContext): Promise<Shipment> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError("PERMISSION_DENIED", "确认发货必须由人类执行");
    }
    const shippedAt = new Date();
    return this.db.transaction(async (tx) => {
      // 双击并发时两次调用都会看到 DRAFT；锁住发货单并带状态条件更新，
      // 保证只有一次确认、一条 SHIPMENT_CONFIRMED 审计。
      const lockedRows = await tx
        .select()
        .from(orderShipments)
        .where(
          and(eq(orderShipments.id, shipmentId), eq(orderShipments.tenantId, this.tenantId)),
        )
        .limit(1)
        .for("update");
      const current = lockedRows[0];
      if (!current) {
        throw new KernelError("RESOURCE_NOT_FOUND", `发货单不存在：${shipmentId}`, {
          resourceType: "order_shipment",
          resourceId: shipmentId,
        });
      }
      if (current.status !== "DRAFT" && current.status !== "PACKED") {
        throw new KernelError("KERNEL_REJECTED", `发货单状态不允许确认发货：${current.status}`, {
          reason: "INVALID_STATE_TRANSITION",
        });
      }
      const rows = await tx
        .update(orderShipments)
        .set({ status: "SHIPPED", shippedAt })
        .where(
          and(
            eq(orderShipments.id, shipmentId),
            eq(orderShipments.tenantId, this.tenantId),
            eq(orderShipments.status, current.status),
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("KERNEL_REJECTED", "发货单状态已变化，请刷新后重试", {
          reason: "VERSION_CONFLICT",
        });
      }
      await tx
        .update(orders)
        .set({ status: "SHIPPED", progressPct: 100, updatedAt: shippedAt })
        .where(and(eq(orders.id, row.orderId), eq(orders.tenantId, this.tenantId)));
      await appendAudit(
        tx,
        ctx,
        {
          action: "SHIPMENT_CONFIRMED",
          entityType: "order_shipment",
          entityId: shipmentId,
          before: { status: current.status },
          after: { status: "SHIPPED", shippedAt: shippedAt.toISOString() },
        },
        this.tenantId,
      );
      const items = await tx
        .select()
        .from(orderShipmentItems)
        .where(eq(orderShipmentItems.shipmentId, shipmentId))
        .orderBy(asc(orderShipmentItems.id));
      return mapShipment(
        row,
        items.map((item) => ({
          id: item.id,
          orderItemId: item.orderItemId,
          quantity: { value: milliToQuantity(item.quantityMilli), unit: item.unit },
        })),
      );
    });
  }
}
