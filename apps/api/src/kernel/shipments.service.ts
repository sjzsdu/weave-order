import { customers, sampleShipmentItems, sampleShipments, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { ApprovalItem, CreateSampleShipmentInput } from "@weave-order/schema";
import type { SampleShipment, SampleShipmentItem } from "@weave-order/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { approvalListConditions } from "./approval-list";
import type { ApprovalListQuery } from "./approval-list";
import type { CustomerService } from "./customers.service";
import { KernelError } from "./errors";
import { ownerScopeFilter } from "./data-scope";
import { milliToQuantity, quantityToMilli } from "./money";
import { toIso, toIsoOrNull } from "./mappers";

type ShipmentRow = typeof sampleShipments.$inferSelect;
type ItemRow = typeof sampleShipmentItems.$inferSelect;

function mapShipment(row: ShipmentRow, items: SampleShipmentItem[]): SampleShipment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    status: row.status,
    channel: row.channel,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    note: row.note,
    items,
    confirmedBy: row.confirmedBy,
    confirmedAt: toIsoOrNull(row.confirmedAt),
    createdAt: toIso(row.createdAt),
  };
}

/**
 * 寄样单内核服务。
 *
 * 铁律 #2 在这里是代码而不是文案：
 * - createDraft 无视调用方任何「status」意图，强制落 DRAFT；
 * - confirm 先判 actor.type === "HUMAN"，智能体/系统调用一律 PERMISSION_DENIED。
 */
export class ShipmentService {
  constructor(
    private readonly db: Db,
    private readonly customers: CustomerService,
    private readonly tenantId: string,
  ) {}

  async createDraft(input: unknown, ctx: KernelContext): Promise<SampleShipment> {
    const parsed = CreateSampleShipmentInput.parse(input);
    // 与 generateDraft 同一口径：建寄样单先看驱动者能不能碰这个客户。
    await this.customers.getById(parsed.customerId, ctx);

    const sampleIds = parsed.items.map((item) => item.sampleId);
    const sampleRows = await this.db
      .select()
      .from(samples)
      .where(and(inArray(samples.id, sampleIds), eq(samples.tenantId, this.tenantId)));
    const samplesById = new Map(sampleRows.map((row) => [row.id, row]));

    for (const item of parsed.items) {
      const sample = samplesById.get(item.sampleId);
      if (!sample) {
        throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${item.sampleId}`, {
          resourceType: "sample",
          resourceId: item.sampleId,
        });
      }
      if (sample.unit !== item.quantity.unit) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `数量单位与样品不一致：样品 ${sample.code} 为 ${sample.unit}，输入为 ${item.quantity.unit}`,
          { reason: "UNIT_MISMATCH" },
        );
      }
    }

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(sampleShipments)
        .values({
          tenantId: this.tenantId,
          customerId: parsed.customerId,
          status: "DRAFT",
          channel: parsed.channel,
          carrier: parsed.carrier ?? null,
          trackingNumber: parsed.trackingNumber ?? null,
          note: parsed.note ?? null,
        })
        .returning();
      const shipmentRow = rows[0];
      if (!shipmentRow) {
        throw new KernelError("KERNEL_REJECTED", "寄样单写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }

      const insertedItems = await tx
        .insert(sampleShipmentItems)
        .values(
          parsed.items.map((item) => ({
            tenantId: this.tenantId,
            shipmentId: shipmentRow.id,
            sampleId: item.sampleId,
            quantityMilli: quantityToMilli(item.quantity.value),
            unit: item.quantity.unit,
          })),
        )
        .returning();

      const items: SampleShipmentItem[] = insertedItems.map((item: ItemRow) => ({
        sampleId: item.sampleId,
        quantity: { value: milliToQuantity(item.quantityMilli), unit: item.unit },
      }));

      await appendAudit(
        tx,
        ctx,
        {
          action: "SAMPLE_SHIPMENT_DRAFTED",
          entityType: "sample_shipment",
          entityId: shipmentRow.id,
          before: null,
          after: {
            customerId: shipmentRow.customerId,
            status: shipmentRow.status,
            itemCount: items.length,
          },
        },
        this.tenantId,
      );

      return mapShipment(shipmentRow, items);
    });
  }

  /** 单条读取；`ctx` 带数据范围时，客户不在范围内的按「不存在」返回。 */
  async getById(shipmentId: string, ctx?: KernelContext): Promise<SampleShipment> {
    // 寄样单归属随客户，与 orders.getById 同一套越权语义，避免枚举他人单据。
    const rows = await this.db
      .select({ shipment: sampleShipments })
      .from(sampleShipments)
      .innerJoin(customers, eq(customers.id, sampleShipments.customerId))
      .where(
        and(
          eq(sampleShipments.id, shipmentId),
          eq(sampleShipments.tenantId, this.tenantId),
          ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
        ),
      )
      .limit(1);
    const row = rows[0]?.shipment;
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `寄样单不存在：${shipmentId}`, {
        resourceType: "sample_shipment",
        resourceId: shipmentId,
      });
    }
    const itemRows = await this.db
      .select()
      .from(sampleShipmentItems)
      .where(eq(sampleShipmentItems.shipmentId, shipmentId))
      .orderBy(asc(sampleShipmentItems.id));
    return mapShipment(
      row,
      itemRows.map((item) => ({
        sampleId: item.sampleId,
        quantity: { value: milliToQuantity(item.quantityMilli), unit: item.unit },
      })),
    );
  }

  /** 人类审批窗口确认寄样单。智能体调用会被内核直接拒绝。 */
  async confirm(shipmentId: string, ctx: KernelContext): Promise<SampleShipment> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "寄样单确认必须由人类在审批窗口执行，智能体无权确认",
      );
    }

    // 确认前先按驱动者的数据范围判可见性：越权当成不存在。
    // 少这一步，看不见这张单的人也能把它确认掉，响应体还会把整单内容回吐给他。
    await this.getById(shipmentId, ctx);

    const confirmedAt = new Date();
    await this.db.transaction(async (tx) => {
      // 状态判断与写入必须在同一事务的锁内：否则并发双击会各自读到 DRAFT，
      // 双双确认并各写一条审计。
      const lockedRows = await tx
        .select()
        .from(sampleShipments)
        .where(and(eq(sampleShipments.id, shipmentId), eq(sampleShipments.tenantId, this.tenantId)))
        .limit(1)
        .for("update");
      const current = lockedRows[0];
      if (!current) {
        throw new KernelError("RESOURCE_NOT_FOUND", `寄样单不存在：${shipmentId}`, {
          resourceType: "sample_shipment",
          resourceId: shipmentId,
        });
      }
      if (current.status !== "DRAFT") {
        throw new KernelError(
          "KERNEL_REJECTED",
          `寄样单当前状态为 ${current.status}，只有 DRAFT 可以确认`,
          { reason: "INVALID_STATE_TRANSITION" },
        );
      }
      const rows = await tx
        .update(sampleShipments)
        .set({
          status: "CONFIRMED",
          confirmedBy: ctx.actor.id,
          confirmedAt,
          updatedAt: confirmedAt,
        })
        .where(
          and(
            eq(sampleShipments.id, shipmentId),
            eq(sampleShipments.tenantId, this.tenantId),
            eq(sampleShipments.status, "DRAFT"),
          ),
        )
        .returning();
      if (!rows[0]) {
        throw new KernelError("KERNEL_REJECTED", "寄样单状态已变化，请刷新后重试", {
          reason: "VERSION_CONFLICT",
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "SAMPLE_SHIPMENT_CONFIRMED",
          entityType: "sample_shipment",
          entityId: shipmentId,
          before: { status: current.status },
          after: { status: "CONFIRMED", confirmedBy: ctx.actor.id },
        },
        this.tenantId,
      );
    });

    return this.getById(shipmentId, ctx);
  }

  /**
   * 审批队列 / 全景的只读视图：把账本里的寄样单映射成 ApprovalItem。
   * 寄样单归属随客户，按客户负责人过滤。
   *
   * 同 `quotes.list`：数据范围与 DRAFT 过滤先于 `limit` / `after`。
   */
  async list(
    limit = 50,
    ctx?: KernelContext,
    query: ApprovalListQuery = {},
  ): Promise<ApprovalItem[]> {
    const conditions: SQL[] = [eq(sampleShipments.tenantId, this.tenantId)];
    const scope = ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId);
    if (scope) conditions.push(scope);
    if (query.pendingOnly) conditions.push(eq(sampleShipments.status, "DRAFT"));
    conditions.push(
      ...approvalListConditions(sampleShipments.createdAt, sampleShipments.id, query),
    );

    const rows = (
      await this.db
        .select({ shipment: sampleShipments })
        .from(sampleShipments)
        .innerJoin(customers, eq(customers.id, sampleShipments.customerId))
        .where(and(...conditions))
        .orderBy(desc(sampleShipments.createdAt), desc(sampleShipments.id))
        .limit(limit)
    ).map((entry) => entry.shipment);
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const itemRows = await this.db
      .select({ shipmentId: sampleShipmentItems.shipmentId })
      .from(sampleShipmentItems)
      .where(inArray(sampleShipmentItems.shipmentId, ids));
    const countBy = new Map<string, number>();
    for (const item of itemRows) {
      countBy.set(item.shipmentId, (countBy.get(item.shipmentId) ?? 0) + 1);
    }

    return rows.map((row) => {
      const logistics = [row.carrier, row.trackingNumber]
        .filter((value): value is string => Boolean(value))
        .join(" ");
      return ApprovalItem.parse({
        id: row.id,
        kind: "sample_shipment",
        title: `寄样单 · ${row.id.slice(0, 8)}`,
        summary: `${countBy.get(row.id) ?? 0} 件样品 · ${logistics || "未填写承运/运单"}`,
        status: row.status,
        pending: row.status === "DRAFT",
        amountCents: null,
        currency: null,
        customerId: row.customerId,
        createdAt: toIso(row.createdAt),
        confirmedBy: row.confirmedBy ?? null,
      });
    });
  }

  /**
   * 某个客户的寄样记录（新→旧）。订单详情用它回答「这单之前寄过什么样」，
   * 寄样单挂在客户名下而不是订单下，所以按客户查而不是按单查。
   */
  async listByCustomer(
    customerId: string,
    limit = 5,
    ctx?: KernelContext,
  ): Promise<SampleShipment[]> {
    const rows = (
      await this.db
        .select({ shipment: sampleShipments })
        .from(sampleShipments)
        .innerJoin(customers, eq(customers.id, sampleShipments.customerId))
        .where(
          and(
            eq(sampleShipments.tenantId, this.tenantId),
            eq(sampleShipments.customerId, customerId),
            ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
          ),
        )
        .orderBy(desc(sampleShipments.createdAt), desc(sampleShipments.id))
        .limit(limit)
    ).map((entry) => entry.shipment);
    if (rows.length === 0) return [];
    const itemRows = await this.db
      .select()
      .from(sampleShipmentItems)
      .where(
        inArray(
          sampleShipmentItems.shipmentId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(sampleShipmentItems.id));
    const byShipment = new Map<string, typeof itemRows>();
    for (const item of itemRows) {
      const bucket = byShipment.get(item.shipmentId) ?? [];
      bucket.push(item);
      byShipment.set(item.shipmentId, bucket);
    }
    return rows.map((row) =>
      mapShipment(
        row,
        (byShipment.get(row.id) ?? []).map((item) => ({
          sampleId: item.sampleId,
          quantity: { value: milliToQuantity(item.quantityMilli), unit: item.unit },
        })),
      ),
    );
  }

  /**
   * 人类在审批窗口驳回寄样单：DRAFT -> CANCELLED，同事务写审计。
   * 智能体无权驳回；只有 DRAFT 能被驳回。
   */
  async reject(
    shipmentId: string,
    ctx: KernelContext,
    note?: string,
  ): Promise<{ status: "CANCELLED" }> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "寄样单驳回必须由人类在审批窗口执行，智能体无权驳回",
      );
    }
    const cancelledAt = new Date();
    await this.db.transaction(async (tx) => {
      const lockedRows = await tx
        .select()
        .from(sampleShipments)
        .where(and(eq(sampleShipments.id, shipmentId), eq(sampleShipments.tenantId, this.tenantId)))
        .limit(1)
        .for("update");
      const current = lockedRows[0];
      if (!current) {
        throw new KernelError("RESOURCE_NOT_FOUND", `寄样单不存在：${shipmentId}`, {
          resourceType: "sample_shipment",
          resourceId: shipmentId,
        });
      }
      if (current.status !== "DRAFT") {
        throw new KernelError(
          "KERNEL_REJECTED",
          `寄样单当前状态为 ${current.status}，只有 DRAFT 可以驳回`,
          { reason: "INVALID_STATE_TRANSITION" },
        );
      }
      const rows = await tx
        .update(sampleShipments)
        .set({ status: "CANCELLED", updatedAt: cancelledAt })
        .where(
          and(
            eq(sampleShipments.id, shipmentId),
            eq(sampleShipments.tenantId, this.tenantId),
            eq(sampleShipments.status, "DRAFT"),
          ),
        )
        .returning();
      if (!rows[0]) {
        throw new KernelError("KERNEL_REJECTED", "寄样单状态已变化，请刷新后重试", {
          reason: "VERSION_CONFLICT",
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "SAMPLE_SHIPMENT_REJECTED",
          entityType: "sample_shipment",
          entityId: shipmentId,
          before: { status: current.status },
          after: { status: "CANCELLED", confirmedBy: ctx.actor.id, note: note ?? null },
        },
        this.tenantId,
      );
    });
    return { status: "CANCELLED" };
  }
}
