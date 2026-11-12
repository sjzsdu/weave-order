import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import {
  actorTypeEnum,
  currencyEnum,
  quoteSendChannelEnum,
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
    index("sample_shipments_customer_idx").on(table.customerId),
    index("sample_shipments_status_idx").on(table.status),
  ],
);

/** 寄样单明细。数量以「千分之一单位」整数存储，避免浮点。 */
export const sampleShipmentItems = pgTable(
  "sample_shipment_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    index("quotes_customer_idx").on(table.customerId),
    index("quotes_status_idx").on(table.status),
  ],
);

/** 报价明细。`lineTotalAmount` 由内核计算，不接受调用方传入。 */
export const quoteItems = pgTable(
  "quote_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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

/**
 * 报价发送记录：一次「导出发给客户」就是一行，只增不改。
 *
 * 与 `quotes.status = SENT` 的区别：`SENT` 表示人已确认，本表才回答
 * 「这份报价到底有没有交出去、交给谁、是哪一版内容」。
 * `snapshot` 存发送时客户看到的内容快照（不可变），`snapshotHash` 是其 sha256，
 * 用来把记录和某一版内容对上，也便于将来重放/比对。
 * `receipt_status` / `receipt_at` / `external_ref` 为将来渠道回执预留，当前为空。
 */
export const quoteSends = pgTable(
  "quote_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    channel: quoteSendChannelEnum("channel").notNull().default("MANUAL_EXPORT"),
    format: varchar("format", { length: 16 }).notNull().default("PDF"),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: varchar("actor_id", { length: 128 }).notNull(),
    /** 发给谁：客户联系人 / 微信 / 邮箱，人工填写，可为空。 */
    recipient: varchar("recipient", { length: 255 }),
    note: text("note"),
    /** 内容快照（客户实际看到的那一版）。 */
    snapshot: jsonb("snapshot").$type<JsonValue>().notNull(),
    snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
    /** 预留：渠道回执。人工导出渠道不产生回执，保持为空。 */
    receiptStatus: varchar("receipt_status", { length: 16 }),
    receiptAt: timestamp("receipt_at", { withTimezone: true }),
    externalRef: varchar("external_ref", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("quote_sends_quote_idx").on(table.quoteId),
    index("quote_sends_created_at_idx").on(table.createdAt),
  ],
);
