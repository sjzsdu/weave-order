import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { JsonValue } from "@weave-order/schema";
import {
  currencyEnum,
  memberRoleEnum,
  quoteStatusEnum,
  shipmentChannelEnum,
  shipmentStatusEnum,
  unitEnum,
} from "./enums";
import { customers } from "./customers";
import { items } from "./items";
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
    /** 编号体系治理：寄样单规则编号；历史行为 NULL。 */
    code: varchar("code", { length: 64 }),
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
    /** 编号体系治理：寄样单规则编号；历史行为 NULL。 */
    uniqueIndex("sample_shipments_tenant_code_idx").on(table.tenantId, table.code),
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
    /**
     * 所属业务事项（P0a-5）。历史报价没有关联，为 NULL；
     * 事项「完成」优先按它校验，避免同客户同样品的另一条事项被误判。
     */
    itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
    status: quoteStatusEnum("status").notNull().default("DRAFT"),
    /** 编号体系治理：规则生成的可寻址编号；历史行为 NULL，回退派生编号。 */
    code: varchar("code", { length: 64 }),
    currency: currencyEnum("currency").notNull(),
    subtotalAmount: bigint("subtotal_amount", { mode: "number" }).notNull(),
    totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
    /** 草稿版本：每次 reviseDraft +1，用于乐观锁与「原稿 vs 修改」diff。 */
    version: integer("version").notNull().default(1),
    /** 智能体原稿快照（items + total），改稿后仍能展示原稿 diff。 */
    baselineSnapshot: jsonb("baseline_snapshot").$type<JsonValue>(),
    /** 当前版本相对原稿的逐行 diff（审批卡直接渲染）。 */
    pendingDiff: jsonb("pending_diff").$type<JsonValue>().notNull().default([]),
    /** 当前草稿需要谁审批；由内核按金额 + 改幅阈值算出。 */
    requiredApprovalRole: memberRoleEnum("required_approval_role"),
    approvalEscalated: boolean("approval_escalated").notNull().default(false),
    escalationReasons: text("escalation_reasons")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** 相对原稿的改幅（万分之一；1% = 100）。 */
    changePctBps: integer("change_pct_bps"),
    lastRevisedAt: timestamp("last_revised_at", { withTimezone: true }),
    validityDays: integer("validity_days").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    remarks: text("remarks"),
    confirmedBy: varchar("confirmed_by", { length: 128 }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** 确认幂等键：同一次点击的重试据此返回原结果，不重复写审计。 */
    confirmIdempotencyKey: varchar("confirm_idempotency_key", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("quotes_tenant_customer_idx").on(table.tenantId, table.customerId),
    index("quotes_tenant_item_idx").on(table.tenantId, table.itemId),
    index("quotes_tenant_status_created_idx").on(table.tenantId, table.status, table.createdAt),
    /**
     * 编号体系治理：新报价写入规则编号；历史行为 NULL，展示层回退派生编号。
     * NULL 不参与唯一约束（Postgres 唯一索引允许多个 NULL），历史数据无需回填。
     */
    uniqueIndex("quotes_tenant_code_idx").on(table.tenantId, table.code),
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
    /** 每个数字的出处：样品 / 智能体建议 / 人工修改 / 定价策略。 */
    provenance: jsonb("provenance").$type<JsonValue>().notNull().default({}),
  },
  (table) => [index("quote_items_quote_idx").on(table.quoteId)],
);
