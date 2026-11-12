import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  currencyEnum,
  quoteStatusEnum,
  shipmentChannelEnum,
  shipmentStatusEnum,
  unitEnum,
} from "./enums";
import { customers } from "./customers";
import { samples } from "./samples";

/**
 * 寄样单。
 * 铁律：智能体只能产出 `DRAFT`；转 `CONFIRMED` 必须由人类在审批窗口确认，
 * 由内核的 confirmSampleShipment 校验 actor.type === "HUMAN"。
 */
export const sampleShipments = pgTable(
  "sample_shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: shipmentStatusEnum("status").notNull().default("DRAFT"),
    channel: shipmentChannelEnum("channel").notNull().default("COURIER"),
    carrier: varchar("carrier", { length: 128 }),
    trackingNumber: varchar("tracking_number", { length: 128 }),
    note: text("note"),
    /** 人类确认人（actor.id），未确认时为空 */
    confirmedBy: varchar("confirmed_by", { length: 128 }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sample_shipments_tenant_customer_idx").on(table.tenantId, table.customerId),
    index("sample_shipments_status_idx").on(table.status),
  ],
);

/** 寄样单明细。数量以「千分之一单位」整数存储，避免浮点。 */
export const sampleShipmentItems = pgTable(
  "sample_shipment_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => sampleShipments.id, { onDelete: "cascade" }),
    sampleId: uuid("sample_id")
      .notNull()
      .references(() => samples.id, { onDelete: "restrict" }),
    quantityMilli: bigint("quantity_milli", { mode: "number" }).notNull(),
    unit: unitEnum("unit").notNull(),
  },
  (table) => [index("sample_shipment_items_shipment_idx").on(table.shipmentId)],
);

/** 报价单。金额一律为整数分，且只允许内核写入。 */
export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: quoteStatusEnum("status").notNull().default("DRAFT"),
    currency: currencyEnum("currency").notNull(),
    subtotalAmount: bigint("subtotal_amount", { mode: "number" }).notNull(),
    totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
    validityDays: integer("validity_days").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    remarks: text("remarks"),
    confirmedBy: varchar("confirmed_by", { length: 128 }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("quotes_tenant_customer_idx").on(table.tenantId, table.customerId),
    index("quotes_tenant_status_created_idx").on(table.tenantId, table.status, table.createdAt),
  ],
);

/** 报价明细。`lineTotalAmount` 由内核计算，不接受调用方传入。 */
export const quoteItems = pgTable(
  "quote_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
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
  (table) => [index("quote_items_quote_idx").on(table.quoteId)],
);
