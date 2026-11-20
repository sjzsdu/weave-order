import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import {
  ocrStatusEnum,
  resourceFieldSourceKindEnum,
  resourceFieldStatusEnum,
  resourceTypeEnum,
  sourceKindEnum,
} from "./enums";

/**
 * 原件（不可变值对象）。
 *
 * 图片/PDF 只存 `objectKey`（`tenant/<tenantId>/...` 前缀，走现有 media 隔离），
 * 文本原件存原话。**没有 updatedAt**：原件一旦写入就不能改写，
 * 字段出处指向它，改原件等于改历史。
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    kind: sourceKindEnum("kind").notNull(),
    /** 图片/PDF 的对象存储 key；文本原件为空。 */
    objectKey: varchar("object_key", { length: 512 }),
    /** 文本原话（含粘贴的聊天记录整段）；图片/PDF 为空。 */
    textContent: text("text_content"),
    mimeType: varchar("mime_type", { length: 128 }),
    byteSize: integer("byte_size"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 「最近上传的原件」与租户清理任务都按这条索引扫。
    index("sources_tenant_created_idx").on(table.tenantId, table.createdAt),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;

/**
 * 字段出处矩阵：一个资源的某个字段，值是什么、从哪来、确认到哪一步。
 *
 * 为什么单独一张表而不是塞进 customers/samples：这是稀疏矩阵
 * （不同资源类型的字段集合不同），塞主表会让主表膨胀且难以按字段状态查询。
 * 逻辑外键（`resource_type` + `resource_id`）不设物理外键：一张表服务三种资源。
 */
export const resourceFields = pgTable(
  "resource_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    /** 资源自身的字段键（`name` / `composition` / `weight` ...）。 */
    fieldName: varchar("field_name", { length: 64 }).notNull(),
    /** 候选值 / 用户确认后的值；结构随字段类型变化。 */
    value: jsonb("value").$type<JsonValue>(),
    status: resourceFieldStatusEnum("status").notNull().default("PENDING"),
    /** 出处原件；`manual` 录入没有原件，为 null。 */
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    sourceKind: resourceFieldSourceKindEnum("source_kind").notNull().default("manual"),
    updatedBy: varchar("updated_by", { length: 128 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 一个资源的同一个字段只有一行：候选值更新是覆盖，不是追加；
    // 冲突值放在 value 之外由 kernel 组合展示，避免同一字段多行各说各话。
    uniqueIndex("resource_fields_tenant_resource_field_idx").on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
      table.fieldName,
    ),
    // 「这个客户还有哪些字段待确认」是确认页的主查询。
    index("resource_fields_tenant_type_status_idx").on(
      table.tenantId,
      table.resourceType,
      table.status,
    ),
    index("resource_fields_source_idx").on(table.sourceId),
  ],
);

export type ResourceFieldRow = typeof resourceFields.$inferSelect;
export type NewResourceFieldRow = typeof resourceFields.$inferInsert;

/**
 * OCR 结果：原件之上的可重放缓存。
 *
 * `raw` 保留 provider 原样输出，`fields` 是抽取后的结构化字段；
 * 分开存是为了「换个模型重抽」时能对比同一张原件，而不是重拍一张。
 */
export const ocrResults = pgTable(
  "ocr_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** 引擎 + 版本（如 `multimodal:xxx@2026-01`），便于回放与 A/B。 */
    engine: varchar("engine", { length: 128 }).notNull(),
    raw: jsonb("raw").$type<JsonValue>(),
    fields: jsonb("fields").$type<JsonValue>(),
    status: ocrStatusEnum("status").notNull().default("PENDING"),
    /** 机器可读的失败原因（不是自由文本），便于按失败模式统计与重试策略。 */
    failureCode: varchar("failure_code", { length: 64 }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 重试任务按状态捞「待办」；失败行要能被后台重试看到。
    index("ocr_results_tenant_status_idx").on(table.tenantId, table.status),
    index("ocr_results_source_idx").on(table.sourceId),
  ],
);

export type OcrResultRow = typeof ocrResults.$inferSelect;
export type NewOcrResultRow = typeof ocrResults.$inferInsert;
