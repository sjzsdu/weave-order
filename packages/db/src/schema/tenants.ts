import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  bigint,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import {
  currencyEnum,
  dataScopeEnum,
  isolationModeEnum,
  memberRoleEnum,
  membershipStatusEnum,
  tenantStatusEnum,
} from "./enums";

/**
 * 租户（控制面实体）。
 * 业务表均以 `tenant_id` 指向这张表；RLS 策略把它单独处理为 `id = app.tenant_id`。
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    brand: varchar("brand", { length: 255 }),
    bank: jsonb("bank").$type<JsonValue>(),
    currency: currencyEnum("currency").notNull().default("CNY"),
    settings: jsonb("settings").$type<JsonValue>().notNull().default({}),
    status: tenantStatusEnum("status").notNull().default("ACTIVE"),
    isolationMode: isolationModeEnum("isolation_mode").notNull().default("SHARED_RLS"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tenants_status_idx").on(table.status)],
);

/**
 * 本地成员映射。
 * `subject` = Casdoor `sub`；租户以本地 membership 为准，不信任令牌里的 org。
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    subject: varchar("subject", { length: 128 }).notNull(),
    casdoorOrg: varchar("casdoor_org", { length: 128 }),
    role: memberRoleEnum("role").notNull(),
    dataScope: dataScopeEnum("data_scope").notNull().default("OWN"),
    teamId: uuid("team_id"),
    approvalLimitAmount: bigint("approval_limit_amount", { mode: "number" }),
    status: membershipStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memberships_tenant_subject_idx").on(table.tenantId, table.subject),
    index("memberships_subject_idx").on(table.subject),
  ],
);
