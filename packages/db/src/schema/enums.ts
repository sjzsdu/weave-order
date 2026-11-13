import { pgEnum } from "drizzle-orm/pg-core";

/**
 * 数据库枚举与 packages/schema 的 Zod 枚举一一对应。
 * 契约的唯一来源仍是 Zod Schema；这里只是它在 PostgreSQL 上的物理表示，
 * 变更时必须两边同步（边界测试会校验取值集合一致）。
 */
export const customerTierEnum = pgEnum("customer_tier", ["VIP", "REGULAR", "NEW", "COLD"]);

export const currencyEnum = pgEnum("currency", ["CNY", "USD", "EUR", "HKD"]);

export const unitEnum = pgEnum("unit", ["meter", "kilogram", "yard", "piece"]);

export const sampleStatusEnum = pgEnum("sample_status", ["ACTIVE", "ARCHIVED"]);

export const shipmentStatusEnum = pgEnum("sample_shipment_status", [
  "DRAFT",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
]);

export const shipmentChannelEnum = pgEnum("shipment_channel", ["COURIER", "EXPRESS", "HAND_CARRY"]);

export const quoteStatusEnum = pgEnum("quote_status", [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
]);

export const actorTypeEnum = pgEnum("actor_type", ["AGENT", "HUMAN", "SYSTEM"]);

export const tenantStatusEnum = pgEnum("tenant_status", ["ACTIVE", "TRIAL", "SUSPENDED", "CLOSED"]);

export const isolationModeEnum = pgEnum("isolation_mode", ["SHARED_RLS", "SCHEMA", "DATABASE"]);

export const memberRoleEnum = pgEnum("member_role", [
  "OWNER",
  "MANAGER",
  "SALES",
  "MERCHANDISER",
  "SAMPLE_ADMIN",
  "FINANCE",
  "VIEWER",
]);

export const dataScopeEnum = pgEnum("data_scope", ["ALL", "TEAM", "OWN"]);

export const membershipStatusEnum = pgEnum("membership_status", ["ACTIVE", "INVITED", "DISABLED"]);

export const orderStatusEnum = pgEnum("order_status", [
  "DRAFT",
  "CONFIRMED",
  "IN_PRODUCTION",
  "SHIPPED",
  "COMPLETED",
  "CANCELLED",
]);

export const orderShipmentStatusEnum = pgEnum("order_shipment_status", [
  "DRAFT",
  "PACKED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
]);

export const receivableStatusEnum = pgEnum("receivable_status", [
  "PENDING",
  "PARTIAL",
  "PAID",
  "OVERDUE",
  "CANCELLED",
]);

export const revisionEntityTypeEnum = pgEnum("revision_entity_type", [
  "quote",
  "order",
  "sample_shipment",
]);

export const revisionSourceEnum = pgEnum("revision_source", ["INLINE", "FORM", "CHAT"]);

export const revisionRequestStatusEnum = pgEnum("revision_request_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
]);

export const quoteShareEventEnum = pgEnum("quote_share_event", [
  "VIEWED",
  "PDF_DOWNLOADED",
  "ACCEPTED",
  "QUESTION_ASKED",
  "REVOKED",
]);

/** 定价策略作用域：系统 → 公司 → 团队/客户/品类 → 个人。 */
export const pricingScopeTypeEnum = pgEnum("pricing_scope_type", [
  "SYSTEM",
  "COMPANY",
  "TEAM",
  "CUSTOMER",
  "CATEGORY",
  "PERSON",
]);

/** 决策增量的业务场景（与 packages/schema 的 ScenarioTag 一致）。 */
export const scenarioTagEnum = pgEnum("scenario_tag", [
  "PRICING",
  "SAMPLE_FOLLOWUP",
  "ORDER_FOLLOWUP",
  "RECONCILIATION",
]);

/** LLM 配置作用域：全局参数 + 租户覆盖。 */
export const llmScopeEnum = pgEnum("llm_scope", ["GLOBAL", "TENANT"]);

/** LLM 任务标签：按任务路由与计量。 */
export const llmTaskEnum = pgEnum("llm_task", [
  "QUOTE_INTENT",
  "QUOTE_DRAFT",
  "FOLLOWUP_SUGGESTION",
  "REPLY_CLASSIFICATION",
]);

/**
 * 用量记录生命周期：RESERVED（调用前占预算）/ SETTLED（按实际结算）/ FAILED（上游失败仍计量）。
 * 预算按「已用 + 预留」汇总，见 apps/api/src/kernel/usage.service.ts。
 */
export const tokenUsageStatusEnum = pgEnum("token_usage_status", ["RESERVED", "SETTLED", "FAILED"]);

/** 打印单据类型（文档与标签共用）。 */
export const printDocumentKindEnum = pgEnum("print_document_kind", [
  "PICKING_LIST",
  "DELIVERY_NOTE",
  "PACKING_LIST",
  "BOX_LABEL",
  "SAMPLE_LABEL",
  "SHELF_LABEL",
  "TEST_LABEL",
]);

/** 模板输出格式：A4 HTML/PDF 与热敏标签指令。 */
export const printTemplateFormatEnum = pgEnum("print_template_format", ["HTML", "ZPL", "TSPL"]);

/** 模板层级：系统 → 公司 → 单据类型。 */
export const printTemplateScopeEnum = pgEnum("print_template_scope", [
  "SYSTEM",
  "COMPANY",
  "DOCUMENT_TYPE",
]);

export const printJobStatusEnum = pgEnum("print_job_status", [
  "QUEUED",
  "SENT",
  "PRINTING",
  "DONE",
  "FAILED",
  "CANCELLED",
]);

export const printAgentStatusEnum = pgEnum("print_agent_status", ["ONLINE", "OFFLINE", "DISABLED"]);

export const printerKindEnum = pgEnum("printer_kind", ["A4", "THERMAL", "BLUETOOTH"]);

export const printerConnectionEnum = pgEnum("printer_connection", [
  "SYSTEM_DRIVER",
  "RAW_TCP",
  "USB",
  "BLUETOOTH",
]);

export const printerStatusEnum = pgEnum("printer_status", ["READY", "OFFLINE", "NEEDS_ATTENTION"]);

export const boxStatusEnum = pgEnum("order_box_status", ["OPEN", "PACKED", "VOIDED"]);

export const boxLabelStatusEnum = pgEnum("box_label_status", ["ACTIVE", "VOIDED"]);

export const scanTypeEnum = pgEnum("scan_event_type", ["PICK", "VERIFY"]);

export const scanResultEnum = pgEnum("scan_result", [
  "OK",
  "MISMATCH",
  "UNKNOWN_CODE",
  "WRONG_BOX",
]);
