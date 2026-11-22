import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { CompositionParts } from "@weave-order/schema";
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
    /**
     * 成分配比（JSON 数组：原料 code + 名称快照 + 百分比）。
     *
     * 与 `composition` 互斥：文本模式只有 `composition`，配比模式由这份明细派生它。
     * 存 jsonb 而不是拆表，是因为一份成分最多十来项、只随样品整体读写，
     * 而「哪些样品含氨纶」这类检索现在还没进需求，拆表会过早付出索引与关联的代价。
     */
    compositionParts: jsonb("composition_parts").$type<CompositionParts | null>(),
    /** 品类（定价继承的 CATEGORY 作用域）。 */
    category: varchar("category", { length: 64 }),
    /** 颜色原文；选项在 `field_options` 的 `sample.color` 治理，不另建颜色表。 */
    color: varchar("color", { length: 64 }),
    /**
     * 克重数值（用户录入时的单位，不折算）。
     * 单位受控（`gsm` / `oz` / `kgm2`），所以数值与单位分列存，不再有自由文本。
     */
    weightValue: numeric("weight_value", { precision: 12, scale: 3, mode: "number" }),
    /** 克重单位；与 `weight_value` 同时有值或同时为空。 */
    weightUnit: varchar("weight_unit", { length: 8 }),
    /** 门幅数值（用户录入时的单位）。 */
    widthValue: numeric("width_value", { precision: 12, scale: 2, mode: "number" }),
    /** 门幅单位：`cm` / `in` / `m`。 */
    widthUnit: varchar("width_unit", { length: 8 }),
    /**
     * 归一克重（整数 g/m²）：区间筛选与比较的唯一口径，由数值 + 单位折算而来。
     * 折不出有效值时为 null，不拿别的单位凑。
     */
    weightGsm: integer("weight_gsm"),
    /** 归一门幅（整数 cm），同样由数值 + 单位折算而来。 */
    widthCm: integer("width_cm"),
    /**
     * 克重检索文本（由 `weight_value` + `weight_unit` 合成，如 `220g/m2`）。
     * 只服务检索与档位筛选：找样按「220g」这类词做子串匹配，
     * 档位选项按精确文本匹配。真相仍是上面两列。
     */
    weightText: varchar("weight_text", { length: 64 }),
    unit: unitEnum("unit").notNull().default("meter"),
    costFloorAmount: bigint("cost_floor_amount", { mode: "number" }),
    costFloorCurrency: currencyEnum("cost_floor_currency"),
    /**
     * `ACTIVE` 是 `AVAILABLE` 的历史别名。列默认值保持 `ACTIVE`：
     * PostgreSQL 不允许在「新增枚举值」的同一事务里把它设为默认值，
     * 内核写入时显式落 `AVAILABLE`（`CreateSampleInput` 默认值），读路径两者等价。
     */
    status: sampleStatusEnum("status").notNull().default("ACTIVE"),
    /** 草稿幂等键：同一张面料标签重复提交只建一个草稿。 */
    draftSourceId: uuid("draft_source_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("samples_tenant_code_idx").on(table.tenantId, table.code),
    uniqueIndex("samples_tenant_draft_source_idx")
      .on(table.tenantId, table.draftSourceId)
      .where(sql`${table.draftSourceId} is not null`),
    index("samples_name_idx").on(table.name),
    index("samples_tenant_color_idx").on(table.tenantId, table.color),
    index("samples_tenant_weight_gsm_idx").on(table.tenantId, table.weightGsm),
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
    /**
     * 图像向量索引状态。图墙据此显示「检索中 / 索引失败」，
     * 而不是把「还没算向量」表现成「搜不到」。
     * 取值：pending | ready | failed（迁移里带 check 约束）。
     */
    indexStatus: varchar("index_status", { length: 16 }).notNull().default("pending"),
    /** 最近一次索引失败的原因（截断到 255），成功时清空。 */
    indexError: varchar("index_error", { length: 255 }),
    /**
     * 服务端派生的持久化缩略图 key（webp）：`.../thumbs/<imageId>_320.webp`
     * 与 `..._640.webp`。DB 只存 key，读 URL 时才拼 CDN/签名地址。
     * 为什么落盘而不是 CDN 参数：本地 MinIO 没有图片处理，参数化签名会坏；
     * 落盘后「图墙只拉缩略图」在本地与生产都是无条件成立的。
     */
    thumb320Key: varchar("thumb_320_key", { length: 512 }),
    thumb640Key: varchar("thumb_640_key", { length: 512 }),
    /** 缩略图派生状态：pending | ready | failed（迁移里带 check 约束）。 */
    thumbStatus: varchar("thumb_status", { length: 16 }).notNull().default("pending"),
    /** 最近一次缩略图派生失败的原因（截断到 255），成功时清空。 */
    thumbError: varchar("thumb_error", { length: 255 }),
    /** 重编码前的原始体积（只在第一次重编码时写入，便于报告真实节省）。 */
    originalByteSize: integer("original_byte_size"),
    /** 重编码完成时间；非空即「已治理」，保证批处理幂等（不会反复压同一张）。 */
    reencodedAt: timestamp("reencoded_at", { withTimezone: true }),
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
    // 索引任务按状态扫「待办」：失败的行要能被后台重试捞到。
    index("sample_images_tenant_index_status_idx").on(table.tenantId, table.indexStatus),
    // 缩略图补派生同样按状态扫「待办」（pending / 上次 failed）。
    index("sample_images_tenant_thumb_status_idx").on(table.tenantId, table.thumbStatus),
  ],
);
