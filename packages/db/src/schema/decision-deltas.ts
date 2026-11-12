import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import { actorTypeEnum, scenarioTagEnum } from "./enums";

/**
 * 决策增量：记录「智能体建议值」被「人类修改后值」覆盖的历史。
 *
 * 这是产品护城河核心，也是可查询的训练信号：
 * - 改价（field=unit_price_0）→ 人类接受/拒绝某档价格
 * - 驳回（field=quote_status）→ 结构化原因进入客户上下文
 *
 * `customer_contexts.decision_deltas` 仍保留最近若干条用于快速读取；
 * 本表是完整、可聚合的历史账本（只追加）。
 */
export const decisionDeltas = pgTable(
  "decision_deltas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    /** 被修改的字段，如 `unit_price_0` / `quote_status`。 */
    field: varchar("field", { length: 128 }).notNull(),
    originalValue: jsonb("original_value").$type<JsonValue>(),
    modifiedValue: jsonb("modified_value").$type<JsonValue>(),
    scenarioTag: scenarioTagEnum("scenario_tag").notNull().default("PRICING"),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: varchar("actor_id", { length: 128 }).notNull(),
    /** 结构化原因（revision_reasons.id），驳回时必填。 */
    reasonId: uuid("reason_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("decision_deltas_tenant_customer_idx").on(table.tenantId, table.customerId),
    index("decision_deltas_entity_idx").on(table.entityType, table.entityId),
  ],
);
