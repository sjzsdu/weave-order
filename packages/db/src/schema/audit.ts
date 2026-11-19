import {
  bigserial,
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import { actorTypeEnum, memberRoleEnum } from "./enums";

/**
 * 审计日志：每一次账本写入都必须在这个表留下不可篡改的一条记录。
 *
 * 铁律的物理落地：
 * - 只能由 kernel 在写业务表的同一事务内追加（写失败则业务写入一起回滚）。
 * - 数据库触发器中禁止 UPDATE / DELETE / TRUNCATE（见 migrations 里的
 *   weave_audit_log_append_only 触发器），因此即使有 SQL 权限也无法改账。
 *
 * 按月 RANGE 分区 `created_at`（WAN-179）：在线保留 24 个月，超期分区由
 * `maintain:audit` 定时 drop。分区表的唯一约束必须包含分区键，因此主键是
 * `(id, created_at)`，`seq` 与 `created_at` 一起唯一；`seq` 仍是全局单调序，
 * 游标分页继续按它做 keyset。
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").notNull().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** 单调递增序号，用于稳定排序与对账。 */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: varchar("actor_id", { length: 128 }).notNull(),
    /** 审批人当时的角色快照（智能体/系统为空），用于还原「当时他有没有这个权限」。 */
    actorRole: memberRoleEnum("actor_role"),
    /**
     * 操作人姓名快照（智能体/系统可为空）。成员改名或离职后，日志仍能显示当时是谁。
     * 历史行为 NULL，前端回退「成员」，不做猜测性回填。
     */
    actorName: varchar("actor_name", { length: 128 }),
    /**
     * 对象名称快照（客户名 / 报价号 / 订单号）。实体改名后日志仍可读，不必回查业务表。
     * 历史行为 NULL，前端回退「业务记录」。
     */
    entityLabel: varchar("entity_label", { length: 255 }),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    before: jsonb("before").$type<JsonValue>(),
    after: jsonb("after").$type<JsonValue>(),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 分区键必须出现在每个唯一约束里（Postgres 硬性要求）。
    primaryKey({ columns: [table.id, table.createdAt] }),
    uniqueIndex("audit_log_seq_created_at_uq").on(table.seq, table.createdAt),
    index("audit_log_tenant_entity_idx").on(
      table.tenantId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index("audit_log_created_at_idx").on(table.createdAt),
    // 日志页的主查询：租户 + 倒序时间 + seq 作为稳定的 keyset 二级键。
    index("audit_log_tenant_created_seq_idx").on(
      table.tenantId,
      table.createdAt.desc(),
      table.seq.desc(),
    ),
    index("audit_log_tenant_actor_idx").on(table.tenantId, table.actorId),
    index("audit_log_tenant_action_idx").on(table.tenantId, table.action),
  ],
);
