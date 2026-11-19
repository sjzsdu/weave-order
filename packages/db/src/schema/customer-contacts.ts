import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { QuoteShareContactSnapshot } from "@weave-order/schema";
import { customers } from "./customers";

/**
 * 客户联系人（WAN-177 / ADR §2.1）。
 *
 * 一家客户 N 个联系人；删除一律归档（`archived_at`），不物理删除。
 * 数据库只硬保证「至多一位有效主要联系人」，三条部分唯一索引各管一件事：
 * - 主联系人唯一：`(customer_id) where is_primary and archived_at is null`
 * - 同客户手机去重：`(customer_id, phone_normalized) where ...`
 * - 同客户邮箱去重：`(customer_id, lower(email)) where ...`
 *
 * 「至少一位主联系人」无法用简单约束表达，由 `ContactService` 的事务保证：
 * 归档主联系人必须同事务先换主；新建客户由表单强制填第一位联系人。
 * 读取层对历史缺主联系人做回退（最近创建的未归档联系人），只回退不写回。
 */
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 255 }).notNull(),
    /** 角色原文；`field_options(field_key='contact.role')` 只做建议、不建外键。 */
    role: varchar("role", { length: 64 }),
    phone: varchar("phone", { length: 64 }),
    /** 写时由 `normalizePhone` 派生；`NULL` 表示没填或不成号，不参与去重。 */
    phoneNormalized: varchar("phone_normalized", { length: 64 }),
    email: varchar("email", { length: 255 }),
    wechat: varchar("wechat", { length: 128 }),
    note: text("note"),
    isPrimary: boolean("is_primary").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 「至多一位」由数据库兜底；应用层负责在换主时同一事务清掉旧主。
    uniqueIndex("customer_contacts_primary_idx")
      .on(table.customerId)
      .where(sql`${table.isPrimary} AND ${table.archivedAt} IS NULL`),
    // 同客户手机重复阻断；跨客户同号只提示（业务上常见两家客户共用一个采购）。
    uniqueIndex("customer_contacts_phone_idx")
      .on(table.customerId, table.phoneNormalized)
      .where(sql`${table.phoneNormalized} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    // 邮箱大小写不敏感去重；`lower(email)` 是表达式索引，冲突判定在应用层统一小写后比较。
    uniqueIndex("customer_contacts_email_idx")
      .on(table.customerId, sql`lower(${table.email})`)
      .where(sql`${table.email} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index("customer_contacts_tenant_customer_idx").on(table.tenantId, table.customerId),
    // 列表 / 搜索按「未归档」过滤；部分索引避免把归档行也带上。
    index("customer_contacts_tenant_active_idx")
      .on(table.tenantId, table.customerId, table.isPrimary)
      .where(sql`${table.archivedAt} IS NULL`),
  ],
);

export type CustomerContactRow = typeof customerContacts.$inferSelect;

/** 复用给 quote_shares 的发送快照类型（避免两处形状漂移）。 */
export type { QuoteShareContactSnapshot };
