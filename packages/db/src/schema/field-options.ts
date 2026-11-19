import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * 字段选项：客户等级 / 样品品类 / 样品成分 / 联系人角色共用一张表。
 *
 * 共表而不是各建一张：四者形状完全一致（稳定 code / 显示名 / 归一化键 / 排序 / 启停），
 * 分表意味着四套 CRUD、四套审计动作、四套解析逻辑，漂移风险成倍。
 * `field_key` 区分字段，`normalized` 是 `normalizeFieldValue` 的派生值，唯一约束防重。
 *
 * 删除一律软删除（`active = false`）：等级 code 仍挂在存量客户上，label 必须能继续解析。
 */
export const fieldOptions = pgTable(
  "field_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** `customer.tier` / `sample.category` / `sample.composition` / `contact.role`。 */
    fieldKey: varchar("field_key", { length: 64 }).notNull(),
    /** 稳定标识；改名只改 label，已软删除的 code 永不复用。 */
    code: varchar("code", { length: 64 }).notNull(),
    label: varchar("label", { length: 128 }).notNull(),
    normalized: varchar("normalized", { length: 128 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 并发同名防重：两人同时新增同一值，一方命中唯一约束后 ON CONFLICT 复用同一行。
    unique("field_options_tenant_field_normalized_uq").on(
      table.tenantId,
      table.fieldKey,
      table.normalized,
    ),
    // code 是等级列的实际引用值，同一字段内不允许两行同 code（含已停用行：code 不复用）。
    unique("field_options_tenant_field_code_uq").on(table.tenantId, table.fieldKey, table.code),
    index("field_options_tenant_field_sort_idx").on(
      table.tenantId,
      table.fieldKey,
      table.sortOrder,
    ),
  ],
);
