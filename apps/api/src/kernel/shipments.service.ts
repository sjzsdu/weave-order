import { sampleShipmentItems, sampleShipments, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { ApprovalItem, CreateSampleShipmentInput } from "@weave-order/schema";
import type { SampleShipment, SampleShipmentItem } from "@weave-order/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import type { CustomerService } from "./customers.service";
import { KernelError } from "./errors";
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
    await this.customers.getById(parsed.customerId);

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

  async getById(shipmentId: string): Promise<SampleShipment> {
    const rows = await this.db
      .select()
      .from(sampleShipments)
      .where(and(eq(sampleShipments.id, shipmentId), eq(sampleShipments.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
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
    const current = await this.getById(shipmentId);
    if (current.status !== "DRAFT") {
      throw new KernelError(
        "KERNEL_REJECTED",
        `寄样单当前状态为 ${current.status}，只有 DRAFT 可以确认`,
        { reason: "INVALID_STATE_TRANSITION" },
      );
    }

    const confirmedAt = new Date();
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(sampleShipments)
        .set({
          status: "CONFIRMED",
          confirmedBy: ctx.actor.id,
          confirmedAt,
          updatedAt: confirmedAt,
        })
        .where(and(eq(sampleShipments.id, shipmentId), eq(sampleShipments.tenantId, this.tenantId)))
        .returning();
      if (!rows[0]) {
        throw new KernelError("RESOURCE_NOT_FOUND", `寄样单不存在：${shipmentId}`, {
          resourceType: "sample_shipment",
          resourceId: shipmentId,
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

    return this.getById(shipmentId);
  }

  /** 审批队列 / 全景的只读视图：把账本里的寄样单映射成 ApprovalItem。 */
  async list(limit = 50): Promise<ApprovalItem[]> {
    const rows = await this.db
      .select()
      .from(sampleShipments)
      .where(eq(sampleShipments.tenantId, this.tenantId))
      .orderBy(desc(sampleShipments.createdAt))
      .limit(limit);
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
    const current = await this.getById(shipmentId);
    if (current.status !== "DRAFT") {
      throw new KernelError(
        "KERNEL_REJECTED",
        `寄样单当前状态为 ${current.status}，只有 DRAFT 可以驳回`,
        { reason: "INVALID_STATE_TRANSITION" },
      );
    }

    const cancelledAt = new Date();
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(sampleShipments)
        .set({ status: "CANCELLED", updatedAt: cancelledAt })
        .where(and(eq(sampleShipments.id, shipmentId), eq(sampleShipments.tenantId, this.tenantId)))
        .returning();
      if (!rows[0]) {
        throw new KernelError("RESOURCE_NOT_FOUND", `寄样单不存在：${shipmentId}`, {
          resourceType: "sample_shipment",
          resourceId: shipmentId,
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
