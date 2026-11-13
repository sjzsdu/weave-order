import { bigserial, index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import { actorTypeEnum, memberRoleEnum } from "./enums";

/**
 * 审计日志：每一次账本写入都必须在这个表留下不可篡改的一条记录。
 *
 * 铁律的物理落地：
 * - 只能由 kernel 在写业务表的同一事务内追加（写失败则业务写入一起回滚）。
 * - 数据库触发器中禁止 UPDATE / DELETE（见 migrations 里的
 *   weave_audit_log_append_only 触发器），因此即使有 SQL 权限也无法改账。
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** 单调递增序号，用于稳定排序与对账。 */
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: varchar("actor_id", { length: 128 }).notNull(),
    /** 审批人当时的角色快照（智能体/系统为空），用于还原「当时他有没有这个权限」。 */
    actorRole: memberRoleEnum("actor_role"),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    before: jsonb("before").$type<JsonValue>(),
    after: jsonb("after").$type<JsonValue>(),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_tenant_entity_idx").on(
      table.tenantId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index("audit_log_created_at_idx").on(table.createdAt),
  ],
);
