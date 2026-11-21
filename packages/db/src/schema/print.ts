import {
  bigint,
  boolean,
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
  boxLabelStatusEnum,
  boxStatusEnum,
  printAgentStatusEnum,
  printDocumentKindEnum,
  printJobStatusEnum,
  printTemplateFormatEnum,
  printTemplateScopeEnum,
  printerConnectionEnum,
  printerKindEnum,
  printerStatusEnum,
  scanResultEnum,
  scanTypeEnum,
} from "./enums";
import { orderItems, orderShipments, orderShipmentItems, orders } from "./orders";

/**
 * 打印模板：系统 → 公司 → 单据类型 三层继承。
 * 模板正文只在 `print_template_versions` 里追加，发布即生成新版本；
 * 已打印的单据绑定当时的版本，保证补打和原件一致。
 */
export const printTemplates = pgTable(
  "print_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    kind: printDocumentKindEnum("kind").notNull(),
    scope: printTemplateScopeEnum("scope").notNull(),
    /** 单据类型覆盖键：如 export / domestic；COMPANY 层为空。 */
    variant: varchar("variant", { length: 64 }),
    name: varchar("name", { length: 128 }).notNull(),
    format: printTemplateFormatEnum("format").notNull(),
    activeVersionId: uuid("active_version_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("print_templates_tenant_kind_idx").on(table.tenantId, table.kind, table.scope),
    uniqueIndex("print_templates_tenant_name_idx").on(table.tenantId, table.kind, table.name),
  ],
);

export const printTemplateVersions = pgTable(
  "print_template_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => printTemplates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    /** 模板引用到的变量/循环路径，发布时由后端白名单校验后落库。 */
    variables: jsonb("variables").$type<JsonValue>().notNull().default([]),
    /**
     * 可视化版式（P0c）：有 layout 的版本由后端编译成 body，
     * 保留它才能让编辑器再次打开时还原版式，而不是解析 HTML。
     */
    layout: jsonb("layout").$type<JsonValue>(),
    pageSize: varchar("page_size", { length: 32 }),
    changelog: varchar("changelog", { length: 500 }),
    publishedBy: varchar("published_by", { length: 128 }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("print_template_versions_template_version_idx").on(table.templateId, table.version),
    index("print_template_versions_tenant_idx").on(table.tenantId),
  ],
);

/** 打印代理：一个租户可有多台（办公室 / 仓库）；token 只存哈希。 */
export const printAgents = pgTable(
  "print_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    location: varchar("location", { length: 128 }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    status: printAgentStatusEnum("status").notNull().default("OFFLINE"),
    appVersion: varchar("app_version", { length: 64 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("print_agents_token_hash_idx").on(table.tokenHash),
    index("print_agents_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

/** 打印机 profile：连接方式、能力、校准参数（偏移/浓度/速度）。 */
export const printers = pgTable(
  "printers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => printAgents.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 128 }).notNull(),
    kind: printerKindEnum("kind").notNull(),
    connection: printerConnectionEnum("connection").notNull(),
    /** RAW_TCP 为 host:port；SYSTEM_DRIVER/USB/BLUETOOTH 存系统队列或设备名。 */
    address: varchar("address", { length: 255 }),
    capabilities: jsonb("capabilities").$type<JsonValue>().notNull().default({}),
    calibration: jsonb("calibration").$type<JsonValue>().notNull().default({}),
    status: printerStatusEnum("status").notNull().default("OFFLINE"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("printers_agent_name_idx").on(table.agentId, table.name),
    index("printers_tenant_idx").on(table.tenantId),
  ],
);

/**
 * 单据快照：对外单据打印时的只读视图（字段白名单）。
 * 事后还原「当时打出来是什么样」，不依赖模板或业务表当前值。
 */
export const documentSnapshots = pgTable(
  "document_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    kind: printDocumentKindEnum("kind").notNull(),
    /** 业务单据 ID：发货单 / 订单 / 箱。 */
    documentId: uuid("document_id").notNull(),
    view: jsonb("view").$type<JsonValue>().notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("document_snapshots_document_idx").on(table.tenantId, table.kind, table.documentId),
  ],
);

/**
 * 打印任务队列。`idempotency_key` 由内核按
 * 单据 + 模板版本 + 份数 + 操作人（箱唛再加 label 序号）计算，唯一索引去重。
 */
export const printJobs = pgTable(
  "print_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    kind: printDocumentKindEnum("kind").notNull(),
    documentId: uuid("document_id").notNull(),
    orderId: uuid("order_id"),
    shipmentId: uuid("shipment_id"),
    boxId: uuid("box_id"),
    labelSeq: integer("label_seq"),
    templateId: uuid("template_id"),
    templateVersionId: uuid("template_version_id"),
    templateVersion: integer("template_version"),
    printerId: uuid("printer_id"),
    agentId: uuid("agent_id"),
    format: printTemplateFormatEnum("format").notNull(),
    copies: integer("copies").notNull().default(1),
    priority: integer("priority").notNull().default(0),
    status: printJobStatusEnum("status").notNull().default("QUEUED"),
    /** 试打：真的出纸，但不进正式打印记录（列表与补打入口都不算它）。 */
    isTest: boolean("is_test").notNull().default(false),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    /** 任务载荷：A4 为 PDF base64，标签为 ZPL/TSPL 文本。 */
    payload: text("payload").notNull(),
    snapshotId: uuid("snapshot_id").references(() => documentSnapshots.id, {
      onDelete: "set null",
    }),
    reprintReason: varchar("reprint_reason", { length: 64 }),
    requestedBy: varchar("requested_by", { length: 128 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: varchar("last_error", { length: 500 }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("print_jobs_idempotency_idx").on(table.tenantId, table.idempotencyKey),
    index("print_jobs_queue_idx").on(table.tenantId, table.status, table.priority, table.createdAt),
    index("print_jobs_shipment_idx").on(table.tenantId, table.shipmentId),
  ],
);

/** 打印回执流水：每次状态变化都留一条，失败原因不会被下一次重试覆盖。 */
export const printJobEvents = pgTable(
  "print_job_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => printJobs.id, { onDelete: "cascade" }),
    status: printJobStatusEnum("status").notNull(),
    message: varchar("message", { length: 500 }),
    agentId: uuid("agent_id"),
    printerId: uuid("printer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("print_job_events_job_idx").on(table.jobId, table.createdAt)],
);

/** 订单箱：一箱一码，QR 内容 = tenant/order/box/seq，不含价格。 */
export const orderBoxes = pgTable(
  "order_boxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => orderShipments.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    boxNo: varchar("box_no", { length: 32 }).notNull(),
    seq: integer("seq").notNull().default(1),
    status: boxStatusEnum("status").notNull().default("OPEN"),
    grossWeightKg: varchar("gross_weight_kg", { length: 32 }),
    size: varchar("size", { length: 64 }),
    note: varchar("note", { length: 500 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: varchar("verified_by", { length: 128 }),
    hasDiscrepancy: boolean("has_discrepancy").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_boxes_shipment_box_no_idx").on(table.shipmentId, table.boxNo),
    index("order_boxes_tenant_order_idx").on(table.tenantId, table.orderId),
  ],
);

export const orderBoxItems = pgTable(
  "order_box_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    boxId: uuid("box_id")
      .notNull()
      .references(() => orderBoxes.id, { onDelete: "cascade" }),
    shipmentItemId: uuid("shipment_item_id")
      .notNull()
      .references(() => orderShipmentItems.id, { onDelete: "restrict" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    quantityMilli: bigint("quantity_milli", { mode: "number" }).notNull(),
    unit: varchar("unit", { length: 16 }).notNull(),
  },
  (table) => [index("order_box_items_box_idx").on(table.boxId)],
);

/** 标签版本：重打生成新 seq，旧标签作废但保留 `voided_at`。 */
export const boxLabels = pgTable(
  "box_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    boxId: uuid("box_id")
      .notNull()
      .references(() => orderBoxes.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    qrPayload: varchar("qr_payload", { length: 255 }).notNull(),
    status: boxLabelStatusEnum("status").notNull().default("ACTIVE"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: varchar("void_reason", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("box_labels_box_seq_idx").on(table.boxId, table.seq),
    index("box_labels_qr_idx").on(table.tenantId, table.qrPayload),
  ],
);

/** 扫码流水：拣货 / 装箱复核都写这里；不一致不会被「下一次顺利」掩盖。 */
export const scanEvents = pgTable(
  "scan_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    boxId: uuid("box_id"),
    type: scanTypeEnum("type").notNull(),
    result: scanResultEnum("result").notNull(),
    qrPayload: varchar("qr_payload", { length: 255 }),
    orderItemId: uuid("order_item_id"),
    quantityMilli: bigint("quantity_milli", { mode: "number" }),
    unit: varchar("unit", { length: 16 }),
    scannedBy: varchar("scanned_by", { length: 128 }).notNull(),
    message: varchar("message", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("scan_events_shipment_idx").on(table.shipmentId, table.createdAt)],
);
