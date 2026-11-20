import { bigint, index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { itemStatusEnum, unitEnum } from "./enums";
import { intents } from "./intents";
import { samples } from "./samples";

/**
 * 业务事项（业务流聚合根）。
 *
 * 事项**引用**客户与样品，不拥有它们：资源是跨事项共享的独立聚合根，
 * 合并资源只发生在资源侧，不把事项卷进分布式事务。
 *
 * `quantityMilli` 沿用「千分之一单位」的整数约定（1.5 米 = 1500），
 * 与金额的整数分同一条纪律：金额与数量都不出现浮点。
 */
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    status: itemStatusEnum("status").notNull().default("IN_PROGRESS"),
    /** 引用而非从属：客户归档后历史事项仍可读。 */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    sampleId: uuid("sample_id").references(() => samples.id, { onDelete: "restrict" }),
    quantityMilli: bigint("quantity_milli", { mode: "number" }),
    unit: unitEnum("unit").notNull().default("meter"),
    /** 展示用阶段文案（「正在核对价格」），由内核维护。 */
    currentStage: varchar("current_stage", { length: 64 }),
    /** 展示用下一步动作（「确认最终价格」）。 */
    nextAction: varchar("next_action", { length: 255 }),
    /** 从哪次输入长出来；输入记录清掉后置空，事项本身仍在。 */
    sourceIntentId: uuid("source_intent_id").references(() => intents.id, { onDelete: "set null" }),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 首页「最近事项」与状态过滤走同一条索引，避免各写一套排序。
    index("items_tenant_status_updated_idx").on(table.tenantId, table.status, table.updatedAt),
    // 「这个客户/样品还有哪些事项」是详情页的高频查询。
    index("items_tenant_customer_idx").on(table.tenantId, table.customerId),
    index("items_tenant_sample_idx").on(table.tenantId, table.sampleId),
  ],
);

/** 事项行（内核写入口与读模型共用）。 */
export type ItemRow = typeof items.$inferSelect;
export type NewItemRow = typeof items.$inferInsert;
