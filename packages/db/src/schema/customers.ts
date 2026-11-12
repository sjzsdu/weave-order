import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  DecisionDelta,
  FollowupPreference,
  PaymentPattern,
  PricingBehavior,
} from "@weave-order/schema";
import { customerTierEnum } from "./enums";

/** 客户主表。只能由 kernel 写入。 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** 客户负责人；为空表示全公司可见（兼容演示数据）。 */
    ownerId: uuid("owner_id"),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    tier: customerTierEnum("tier").notNull().default("REGULAR"),
    contactName: varchar("contact_name", { length: 255 }),
    contactPhone: varchar("contact_phone", { length: 64 }),
    contactEmail: varchar("contact_email", { length: 255 }),
    /** 乐观并发版本号，账本更新时用于检测并发写入。 */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customers_tenant_code_idx").on(table.tenantId, table.code),
    index("customers_tenant_owner_idx").on(table.tenantId, table.ownerId),
    index("customers_name_idx").on(table.name),
  ],
);

/**
 * 客户私有上下文（护城河核心）。
 * 与客户一对一；创建客户时由内核自动写入默认值。
 */
export const customerContexts = pgTable("customer_contexts", {
  customerId: uuid("customer_id")
    .primaryKey()
    .references(() => customers.id, { onDelete: "restrict" }),
  tenantId: uuid("tenant_id").notNull(),
  preferenceNotes: text("preference_notes")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  pricingBehavior: jsonb("pricing_behavior").$type<PricingBehavior>().notNull(),
  paymentPattern: jsonb("payment_pattern").$type<PaymentPattern>().notNull(),
  followupPreference: jsonb("followup_preference").$type<FollowupPreference>().notNull(),
  decisionDeltas: jsonb("decision_deltas")
    .$type<DecisionDelta[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
