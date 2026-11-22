import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { currencyEnum, orderShipmentStatusEnum, orderStatusEnum, unitEnum } from "./enums";
import { customers } from "./customers";
import { samples } from "./samples";

/** 订单主表（非寄样）。金额整数分。 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    quoteId: uuid("quote_id"),
    code: varchar("code", { length: 64 }).notNull(),
    status: orderStatusEnum("status").notNull().default("DRAFT"),
    currency: currencyEnum("currency").notNull(),
    totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }),
    progressPct: integer("progress_pct").notNull().default(0),
    confirmedBy: varchar("confirmed_by", { length: 128 }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("orders_tenant_due_status_idx").on(table.tenantId, table.dueDate, table.status),
    index("orders_tenant_customer_idx").on(table.tenantId, table.customerId),
    /**
     * 编号体系治理：订单 code 列原本就非空，但缺唯一约束（可重号不报错）。
     * 迁移前置检查按 (tenant_id, code) 分组阻断存量重号后再建此索引。
     */
    uniqueIndex("orders_tenant_code_idx").on(table.tenantId, table.code),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    sampleId: uuid("sample_id")
      .notNull()
      .references(() => samples.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    quantityMilli: bigint("quantity_milli", { mode: "number" }).notNull(),
    unit: unitEnum("unit").notNull(),
    unitPriceAmount: bigint("unit_price_amount", { mode: "number" }).notNull(),
    lineTotalAmount: bigint("line_total_amount", { mode: "number" }).notNull(),
  },
  (table) => [index("order_items_order_idx").on(table.orderId)],
);

/** 订单发货单。与 `sample_shipments`（寄样）是两张不同的表。 */
export const orderShipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    status: orderShipmentStatusEnum("status").notNull().default("DRAFT"),
    carrier: varchar("carrier", { length: 128 }),
    trackingNumber: varchar("tracking_number", { length: 128 }),
    address: text("address"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("shipments_tenant_order_idx").on(table.tenantId, table.orderId)],
);

export const orderShipmentItems = pgTable(
  "shipment_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => orderShipments.id, { onDelete: "cascade" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    quantityMilli: bigint("quantity_milli", { mode: "number" }).notNull(),
    unit: unitEnum("unit").notNull(),
  },
  (table) => [index("shipment_items_shipment_idx").on(table.shipmentId)],
);
