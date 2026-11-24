import {
  boxLabels,
  customers,
  orderBoxItems,
  orderBoxes,
  orderItems,
  orderShipmentItems,
  orderShipments,
  orders,
  printJobs,
  samples,
  scanEvents,
  tenants,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  OrderBox as OrderBoxSchema,
  OrderShippingSummary,
  PrintDocumentKindLabel,
  ShipmentScanEvent as ShipmentScanEventSchema,
  ShipmentView,
} from "@weave-order/schema";
import type {
  DocumentView,
  OrderBox,
  PrintDocumentKind,
  ShipmentScanEvent,
  Unit,
} from "@weave-order/schema";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { shipmentNo } from "../order-shipments.service";
import { KernelError } from "../errors";
import { multiplyCents } from "../money";
import { toIso, toIsoOrNull } from "../mappers";
import { buildBoxQr } from "./qr";

function settingString(settings: unknown, key: string, fallback: string): string {
  if (settings && typeof settings === "object" && key in settings) {
    const value = (settings as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function roundQuantity(milli: number): number {
  return Math.round((milli / 1000) * 1000) / 1000;
}

export class PrintViewService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  /** 发货单只读视图：明细 + 箱 + 扫码记录 + 打印拦截原因。 */
  async getShipmentView(shipmentId: string): Promise<ShipmentView> {
    const shipmentRows = await this.db
      .select()
      .from(orderShipments)
      .where(and(eq(orderShipments.id, shipmentId), eq(orderShipments.tenantId, this.tenantId)))
      .limit(1);
    const shipment = shipmentRows[0];
    if (!shipment) {
      throw new KernelError("RESOURCE_NOT_FOUND", `发货单不存在：${shipmentId}`, {
        resourceType: "order_shipment",
        resourceId: shipmentId,
      });
    }
    const orderRows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, shipment.orderId), eq(orders.tenantId, this.tenantId)))
      .limit(1);
    const order = orderRows[0]!;
    const customerRows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, order.customerId), eq(customers.tenantId, this.tenantId)))
      .limit(1);
    const customer = customerRows[0]!;

    const shipmentItemRows = await this.db
      .select()
      .from(orderShipmentItems)
      .where(eq(orderShipmentItems.shipmentId, shipmentId))
      .orderBy(asc(orderShipmentItems.id));
    const orderItemRows = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.position));
    const orderItemsById = new Map(orderItemRows.map((item) => [item.id, item]));
    const sampleRows = await this.db
      .select()
      .from(samples)
      .where(
        and(
          eq(samples.tenantId, this.tenantId),
          inArray(
            samples.id,
            orderItemRows.map((item) => item.sampleId),
          ),
        ),
      );
    const samplesById = new Map(sampleRows.map((sample) => [sample.id, sample]));

    // 同一订单行的累计发货量（取消的发货单不算）
    const shippedRows = await this.db
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
    const shippedByOrderItem = new Map<string, number>();
    for (const row of shippedRows) {
      shippedByOrderItem.set(
        row.orderItemId,
        (shippedByOrderItem.get(row.orderItemId) ?? 0) + row.quantityMilli,
      );
    }

    const items = shipmentItemRows.map((item) => {
      const orderItem = orderItemsById.get(item.orderItemId)!;
      const sample = samplesById.get(orderItem.sampleId);
      return {
        shipmentItemId: item.id,
        orderItemId: item.orderItemId,
        sampleId: orderItem.sampleId,
        sampleCode: sample?.code ?? "",
        description: orderItem.description,
        orderedQuantity: roundQuantity(orderItem.quantityMilli),
        shippedQuantity: roundQuantity(shippedByOrderItem.get(item.orderItemId) ?? 0),
        quantity: roundQuantity(item.quantityMilli),
        unit: item.unit,
        unitPriceCents: orderItem.unitPriceAmount,
        location: null,
      };
    });

    const boxes = await this.listBoxes(shipmentId);
    const scans = await this.listScans(shipmentId);
    const totalQuantity = roundQuantity(
      shipmentItemRows.reduce((sum, item) => sum + item.quantityMilli, 0),
    );
    const boxQuantity = roundQuantity(
      boxes.reduce((sum, box) => sum + Math.round(box.quantity * 1000), 0),
    );
    const hasDiscrepancy = boxes.some((box) => box.hasDiscrepancy);
    const printBlockedReason = hasDiscrepancy
      ? ("DISCREPANCY" as const)
      : boxes.length === 0
        ? ("NO_BOXES" as const)
        : Math.abs(boxQuantity - totalQuantity) > 0.0005
          ? ("QUANTITY_MISMATCH" as const)
          : null;

    return ShipmentView.parse({
      id: shipment.id,
      orderId: order.id,
      orderNo: order.code,
      customerId: customer.id,
      customerName: customer.name,
      status: shipment.status,
      currency: order.currency,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      address: shipment.address,
      items,
      boxes,
      scans,
      totalQuantity,
      boxQuantity,
      printBlockedReason,
      createdAt: toIso(shipment.createdAt),
      shippedAt: toIsoOrNull(shipment.shippedAt),
    });
  }

  async listBoxes(shipmentId: string): Promise<OrderBox[]> {
    const rows = await this.db
      .select()
      .from(orderBoxes)
      .where(and(eq(orderBoxes.shipmentId, shipmentId), eq(orderBoxes.tenantId, this.tenantId)))
      .orderBy(asc(orderBoxes.boxNo));
    if (rows.length === 0) return [];
    const boxIds = rows.map((row) => row.id);
    const itemRows = await this.db
      .select()
      .from(orderBoxItems)
      .where(inArray(orderBoxItems.boxId, boxIds));
    const labelRows = await this.db
      .select()
      .from(boxLabels)
      .where(inArray(boxLabels.boxId, boxIds))
      .orderBy(asc(boxLabels.boxId), desc(boxLabels.seq));
    const jobRows = await this.db
      .select({
        boxId: printJobs.boxId,
        labelSeq: printJobs.labelSeq,
        status: printJobs.status,
        completedAt: printJobs.completedAt,
      })
      .from(printJobs)
      .where(
        and(
          eq(printJobs.tenantId, this.tenantId),
          eq(printJobs.shipmentId, shipmentId),
          eq(printJobs.kind, "BOX_LABEL"),
          eq(printJobs.status, "DONE"),
        ),
      );
    const orderItemIds = [...new Set(itemRows.map((item) => item.orderItemId))];
    const orderItemRows = orderItemIds.length
      ? await this.db.select().from(orderItems).where(inArray(orderItems.id, orderItemIds))
      : [];
    const descriptions = new Map(orderItemRows.map((item) => [item.id, item.description]));
    const itemsByBox = new Map<string, typeof itemRows>();
    for (const item of itemRows) {
      const list = itemsByBox.get(item.boxId) ?? [];
      list.push(item);
      itemsByBox.set(item.boxId, list);
    }
    const labelByBox = new Map<string, (typeof labelRows)[number]>();
    for (const label of labelRows) {
      if (!labelByBox.has(label.boxId)) labelByBox.set(label.boxId, label);
    }
    const printedByBox = new Map<string, { count: number; lastAt: Date | null }>();
    for (const job of jobRows) {
      if (!job.boxId) continue;
      const entry = printedByBox.get(job.boxId) ?? { count: 0, lastAt: null };
      entry.count += 1;
      if (job.completedAt && (!entry.lastAt || job.completedAt > entry.lastAt)) {
        entry.lastAt = job.completedAt;
      }
      printedByBox.set(job.boxId, entry);
    }

    return rows.map((row) => {
      const label = labelByBox.get(row.id);
      const boxItems = itemsByBox.get(row.id) ?? [];
      const printed = printedByBox.get(row.id);
      return OrderBoxSchema.parse({
        id: row.id,
        shipmentId: row.shipmentId,
        boxNo: row.boxNo,
        seq: row.seq,
        qr:
          label?.qrPayload ??
          buildBoxQr({
            tenantId: this.tenantId,
            orderId: row.orderId,
            boxNo: row.boxNo,
            seq: row.seq,
          }),
        status: row.status,
        quantity: roundQuantity(boxItems.reduce((sum, item) => sum + item.quantityMilli, 0)),
        items: boxItems.map((item) => ({
          shipmentItemId: item.shipmentItemId,
          orderItemId: item.orderItemId,
          description: descriptions.get(item.orderItemId) ?? "",
          quantity: roundQuantity(item.quantityMilli),
          unit: item.unit as Unit,
        })),
        grossWeightKg: row.grossWeightKg,
        size: row.size,
        note: row.note,
        hasDiscrepancy: row.hasDiscrepancy,
        verifiedAt: toIsoOrNull(row.verifiedAt),
        printedAt: printed?.lastAt ? toIso(printed.lastAt) : null,
        printCount: printed?.count ?? 0,
        createdAt: toIso(row.createdAt),
      });
    });
  }

  async listScans(shipmentId: string, limit = 50): Promise<ShipmentScanEvent[]> {
    const rows = await this.db
      .select()
      .from(scanEvents)
      .where(and(eq(scanEvents.shipmentId, shipmentId), eq(scanEvents.tenantId, this.tenantId)))
      .orderBy(desc(scanEvents.createdAt))
      .limit(limit);
    return rows.map((row) =>
      ShipmentScanEventSchema.parse({
        id: row.id,
        type: row.type,
        result: row.result,
        qrPayload: row.qrPayload,
        orderItemId: row.orderItemId,
        quantity: row.quantityMilli === null ? null : roundQuantity(row.quantityMilli),
        unit: row.unit as Unit | null,
        message: row.message,
        scannedBy: row.scannedBy,
        createdAt: toIso(row.createdAt),
      }),
    );
  }

  /**
   * 单据视图：金额与数量只来自内核（订单行 + 实发数量），模板拿不到别的字段。
   */
  async buildDocumentView(input: {
    kind: PrintDocumentKind;
    shipmentId?: string;
    boxId?: string;
    operator: string;
    reprintReason?: DocumentView["meta"]["reprintReason"];
    printedAt?: Date;
  }): Promise<DocumentView> {
    if (!input.shipmentId) {
      throw new KernelError("KERNEL_REJECTED", "打印单据需要发货单 id");
    }
    const view = await this.getShipmentView(input.shipmentId);
    const orderRows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, view.orderId), eq(orders.tenantId, this.tenantId)))
      .limit(1);
    const order = orderRows[0]!;
    const tenantRows = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, this.tenantId))
      .limit(1);
    const tenant = tenantRows[0];
    const customerRows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, view.customerId), eq(customers.tenantId, this.tenantId)))
      .limit(1);
    const customer = customerRows[0]!;

    const missing: string[] = [];
    if (!view.address && !customer.contactPhone) missing.push("shipment.address");
    if (view.boxes.length === 0) missing.push("boxes");
    if (input.boxId && !view.boxes.some((box) => box.id === input.boxId)) {
      throw new KernelError("RESOURCE_NOT_FOUND", `箱不存在或不属于该发货单：${input.boxId}`);
    }

    const lines = view.items.map((item, index) => ({
      position: index,
      description: item.description,
      sampleCode: item.sampleCode || null,
      quantity: item.quantity,
      unit: item.unit,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: multiplyCents(item.unitPriceCents, Math.round(item.quantity * 1000)),
      location: item.location,
      lot: null,
    }));
    const amountCents = lines.reduce((sum, line) => sum + (line.lineTotalCents ?? 0), 0);
    const settings = tenant?.settings;
    const printedAt = input.printedAt ?? new Date();

    return {
      kind: input.kind,
      title: PrintDocumentKindLabel[input.kind],
      locale: "zh-CN",
      tenant: {
        name: tenant?.name ?? "—",
        contactName: null,
        phone: settingString(settings, "printPhone", ""),
        email: settingString(settings, "printEmail", ""),
        address: settingString(settings, "printAddress", ""),
      },
      customer: {
        name: customer.name,
        contactName: customer.contactName,
        phone: customer.contactPhone,
        email: customer.contactEmail,
        address: null,
      },
      order: {
        id: order.id,
        no: order.code,
        date: toIso(order.createdAt),
        dueDate: toIsoOrNull(order.dueDate),
        currency: order.currency,
      },
      shipment: {
        id: view.id,
        no: shipmentNo(view.id),
        date: toIso(new Date(view.createdAt)),
        carrier: view.carrier,
        trackingNumber: view.trackingNumber,
        address: view.address,
        boxCount: view.boxes.length,
        quantity: view.totalQuantity,
      },
      lines,
      boxes: view.boxes.map((box) => ({
        boxNo: box.boxNo,
        seq: box.seq,
        qr: box.qr,
        quantity: box.quantity,
        itemCount: box.items.length,
        grossWeightKg: box.grossWeightKg,
        size: box.size,
      })),
      totals: {
        quantity: view.totalQuantity,
        currency: order.currency,
        amountCents,
      },
      meta: {
        printedAt: printedAt.toISOString(),
        operator: input.operator,
        reprintReason: input.reprintReason ?? null,
        missing,
      },
    };
  }

  /** 顶部「待发货」列表：打印抽屉与工作台共用。 */
  async listPendingShipping(limit = 20): Promise<OrderShippingSummary[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, this.tenantId),
          inArray(orders.status, ["CONFIRMED", "IN_PRODUCTION"]),
        ),
      )
      .orderBy(desc(orders.updatedAt))
      .limit(limit);
    if (rows.length === 0) return [];
    const orderIds = rows.map((row) => row.id);
    const itemRows = await this.db
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds));
    const shipmentRows = await this.db
      .select()
      .from(orderShipments)
      .where(
        and(
          eq(orderShipments.tenantId, this.tenantId),
          inArray(orderShipments.orderId, orderIds),
          ne(orderShipments.status, "CANCELLED"),
        ),
      );
    const shipmentItems = shipmentRows.length
      ? await this.db
          .select()
          .from(orderShipmentItems)
          .where(
            inArray(
              orderShipmentItems.shipmentId,
              shipmentRows.map((row) => row.id),
            ),
          )
      : [];
    const boxRows = shipmentRows.length
      ? await this.db
          .select()
          .from(orderBoxes)
          .where(
            inArray(
              orderBoxes.shipmentId,
              shipmentRows.map((row) => row.id),
            ),
          )
      : [];
    const customerRows = await this.db
      .select()
      .from(customers)
      .where(inArray(customers.id, [...new Set(rows.map((row) => row.customerId))]));
    const customerNames = new Map(customerRows.map((row) => [row.id, row.name]));
    const orderItemsByOrder = new Map<string, typeof itemRows>();
    for (const item of itemRows) {
      const list = orderItemsByOrder.get(item.orderId) ?? [];
      list.push(item);
      orderItemsByOrder.set(item.orderId, list);
    }
    const shipmentIdsByOrder = new Map<string, string[]>();
    for (const row of shipmentRows) {
      const list = shipmentIdsByOrder.get(row.orderId) ?? [];
      list.push(row.id);
      shipmentIdsByOrder.set(row.orderId, list);
    }
    const shippedByShipment = new Map<string, number>();
    for (const item of shipmentItems) {
      shippedByShipment.set(
        item.shipmentId,
        (shippedByShipment.get(item.shipmentId) ?? 0) + item.quantityMilli,
      );
    }

    return rows.map((row) => {
      const shipmentIds = shipmentIdsByOrder.get(row.id) ?? [];
      const totalMilli = (orderItemsByOrder.get(row.id) ?? []).reduce(
        (sum, item) => sum + item.quantityMilli,
        0,
      );
      return OrderShippingSummary.parse({
        orderId: row.id,
        orderNo: row.code,
        customerName: customerNames.get(row.customerId) ?? "—",
        status: row.status,
        currency: row.currency,
        totalCents: row.totalAmount,
        totalQuantity: roundQuantity(totalMilli),
        shippedQuantity: roundQuantity(
          shipmentIds.reduce((sum, id) => sum + (shippedByShipment.get(id) ?? 0), 0),
        ),
        shipmentCount: shipmentIds.length,
        hasDiscrepancy: boxRows.some(
          (box) => shipmentIds.includes(box.shipmentId) && box.hasDiscrepancy,
        ),
        updatedAt: toIso(row.updatedAt),
      });
    });
  }
}
