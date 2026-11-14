import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { currencyEnum, sampleImageVariantEnum, sampleStatusEnum, unitEnum } from "./enums";

/**
 * 面料样品。
 * `costFloorAmount` 是内核报价时的价格底线（整数分）；
 * 智能体建议单价低于此线一律 KERNEL_REJECTED，LLM 无法绕过。
 */
export const samples = pgTable(
  "samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    composition: varchar("composition", { length: 255 }),
    /** 品类（定价继承的 CATEGORY 作用域）。 */
    category: varchar("category", { length: 64 }),
    /** 克重描述，如 "220g/m2" */
    weight: varchar("weight", { length: 64 }),
    unit: unitEnum("unit").notNull().default("meter"),
    costFloorAmount: bigint("cost_floor_amount", { mode: "number" }),
    costFloorCurrency: currencyEnum("cost_floor_currency"),
    status: sampleStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("samples_tenant_code_idx").on(table.tenantId, table.code),
    index("samples_name_idx").on(table.name),
  ],
);

/**
 * 样品图片：**DB 只存 object_key，不存 URL**。
 * 换 CDN / 换桶只要改 `MEDIA_BASE_URL`，不需要回写业务数据。
 * `sampleId` 级联删除：删样品即清掉图片行（桶里的对象留给 P1 回收任务）。
 */
export const sampleImages = pgTable(
  "sample_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    sampleId: uuid("sample_id")
      .notNull()
      .references(() => samples.id, { onDelete: "cascade" }),
    objectKey: varchar("object_key", { length: 512 }).notNull().unique(),
    variant: sampleImageVariantEnum("variant").notNull().default("primary"),
    isPrimary: boolean("is_primary").notNull().default(false),
    mimeType: varchar("mime_type", { length: 32 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 每样品最多一张主图；由数据库兜底，应用层的「先清后设」只是体验优化。
    uniqueIndex("sample_images_primary_per_sample_idx")
      .on(table.sampleId)
      .where(sql`is_primary = true`),
    index("sample_images_tenant_sample_sort_idx").on(
      table.tenantId,
      table.sampleId,
      table.sortOrder,
    ),
  ],
);
