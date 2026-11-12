import {
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
import type { JsonValue } from "@weave-order/schema";
import { pricingScopeTypeEnum } from "./enums";

/**
 * 定价策略：系统 → 公司 → 团队/客户/品类 → 个人。
 *
 * - `locked = true` 为管控类：下级只能收紧，不能放宽。
 * - `scopeId`：SYSTEM 为 null；COMPANY 为 tenantId；其余为对应实体 ID。
 * - 解析时按 scope 层级 + priority 排序，管控键做 min/max 夹取。
 */
export const pricingPolicies = pgTable(
  "pricing_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    scopeType: pricingScopeTypeEnum("scope_type").notNull(),
    scopeId: varchar("scope_id", { length: 128 }),
    key: varchar("key", { length: 64 }).notNull(),
    value: jsonb("value").$type<JsonValue>().notNull(),
    priority: integer("priority").notNull().default(0),
    locked: boolean("locked").notNull().default(false),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pricing_policies_tenant_scope_key_idx").on(
      table.tenantId,
      table.scopeType,
      table.scopeId,
      table.key,
    ),
    index("pricing_policies_tenant_key_idx").on(table.tenantId, table.key),
  ],
);

/** 策略变更日志：只追加，审计的二级索引（按策略维度看历史）。 */
export const policyChangeLog = pgTable(
  "policy_change_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => pricingPolicies.id, { onDelete: "restrict" }),
    action: varchar("action", { length: 32 }).notNull(),
    oldValue: jsonb("old_value").$type<JsonValue>(),
    newValue: jsonb("new_value").$type<JsonValue>(),
    actorId: varchar("actor_id", { length: 128 }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("policy_change_log_policy_idx").on(table.policyId, table.createdAt)],
);
