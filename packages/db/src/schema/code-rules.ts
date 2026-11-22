import {
  bigint,
  boolean,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * 编号规则：每租户 × 每实体一条。
 *
 * `template` 用占位符串（见 @weave-order/schema 的 code-rule），解析/渲染在
 * schema 包完成，这里只负责持久化。变更历史走 audit_log（entityType=code_rule），
 * 不单独建 change log 表。
 *
 * RLS：与所有业务表一致，tenant_id = 会话租户；见 drizzle 迁移与 sql/rls.sql。
 */
export const codeRules = pgTable(
  "code_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** customer | sample | quote | order | sample_shipment */
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    template: varchar("template", { length: 128 }).notNull(),
    /** 套用的预设 key；null = 自定义 */
    presetKey: varchar("preset_key", { length: 64 }),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("code_rules_tenant_entity_idx").on(table.tenantId, table.entityType),
    index("code_rules_tenant_idx").on(table.tenantId),
  ],
);

/**
 * 取号计数器：按 (租户, 实体, 分桶) 原子递增。
 *
 * 取号与业务写入在同一事务内，靠 `INSERT ... ON CONFLICT DO UPDATE SET seq = seq + 1
 * RETURNING` 保证同桶并发拿到不同序号。分桶 = 模板渲染后去掉序号的字面部分，
 * 换天 / 改规则自然换桶、序号独立起算（「规则变更不追溯历史」）。
 */
export const codeCounters = pgTable(
  "code_counters",
  {
    tenantId: uuid("tenant_id").notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    bucket: varchar("bucket", { length: 128 }).notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.entityType, table.bucket] })],
);
