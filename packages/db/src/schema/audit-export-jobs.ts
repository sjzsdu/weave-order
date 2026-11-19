import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";

/**
 * 审计导出任务（WAN-179）。
 *
 * 导出一律异步：`POST /api/audit/log/export` 只建 job 就返回，后台生成 CSV
 * 写入对象存储，前端轮询状态拿短期签名地址。数据量小时 job 秒级完成，
 * 用户感知与同步导出无差别，但不必为「大租户」维护第二条代码路径。
 *
 * `filter` 保存创建时的筛选条件（含范围 ALL/OWN），后台任务据此重放查询，
 * 保证「点导出那一刻看到什么，就导出什么」。
 */
export const auditExportJobs = pgTable(
  "audit_export_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    requestedBy: varchar("requested_by", { length: 128 }).notNull(),
    requestedByName: varchar("requested_by_name", { length: 128 }),
    requestedByRole: varchar("requested_by_role", { length: 32 }),
    /** PENDING / RUNNING / SUCCEEDED / FAILED */
    status: varchar("status", { length: 16 }).notNull().default("PENDING"),
    filter: jsonb("filter").$type<JsonValue>().notNull(),
    rowCount: integer("row_count"),
    objectKey: varchar("object_key", { length: 512 }),
    fileName: varchar("file_name", { length: 255 }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** 下载链接与任务结果的保留期（默认 7 天）。 */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("audit_export_jobs_tenant_created_idx").on(table.tenantId, table.createdAt)],
);
