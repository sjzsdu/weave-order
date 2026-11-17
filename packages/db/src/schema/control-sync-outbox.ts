import { index, integer, pgTable, text, timestamp, varchar, uuid } from "drizzle-orm/pg-core";

/**
 * 控制面登记 outbox（Transactional Outbox 模式）。
 *
 * 问题背景：租户端创建公司写业务库 `tenants`/`memberships`，控制面（账单/订阅）
 * 在另一个独立库。两库没有分布式事务，过去靠创建后一条「失败即吞」的 HTTP 调用对齐，
 * 导致「用户建了公司、总后台看不到」。
 *
 * 这张表是权威源（业务库）侧的「登记意图」账本：
 * - 与 tenants 在**同一个数据库事务**里写入，租户落地 ⟺ 登记意图落地，杜绝半瘸状态；
 * - worker 扫 pending 行可靠投递到控制面内部接口，失败退避重试，超过阈值转 dead 并告警；
 * - 定时对账再兜底比对两库，差异自动补登。
 *
 * 这是平台级表（无 tenant_id），不套租户 RLS；由 owner 连接读写（与 tenants 同连接），
 * 不在 packages/db/sql/rls.sql 的业务表清单内。
 */
export const controlSyncOutbox = pgTable(
  "control_sync_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 业务库租户 id，仅作追踪；控制面以 slug 幂等。 */
    tenantId: uuid("tenant_id").notNull(),
    /** 幂等键：与控制面 control.tenants.slug 对齐。 */
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    ownerEmail: varchar("owner_email", { length: 255 }),
    /** pending → synced / failed / dead。 */
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (table) => [index("control_sync_outbox_status_next_idx").on(table.status, table.nextAttemptAt)],
);

export type ControlSyncOutboxRow = typeof controlSyncOutbox.$inferSelect;
export type NewControlSyncOutboxRow = typeof controlSyncOutbox.$inferInsert;
