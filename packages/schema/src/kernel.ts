import { z } from "zod";
import {
  CustomerTier,
  EntityId,
  JsonValueSchema,
  Money,
  Quantity,
  SampleStatus,
  ShipmentChannel,
  Timestamp,
  Unit,
} from "./domain";

/**
 * 确定性内核的输入契约。
 *
 * 这些 Schema 与工具契约同源（同一个 packages/schema），内核与工具层
 * 都从这里取类型，禁止在 apps/api 里重复定义。
 * 所有输入 `strict()`：未知字段一律拒绝（契约宁可拒，避免智能体夹带账本字段）。
 */

/** 创建客户。 */
export const CreateCustomerInput = z
  .object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    tier: CustomerTier.default("REGULAR"),
    contactName: z.string().max(255).nullable().optional(),
    contactPhone: z.string().max(64).nullable().optional(),
    contactEmail: z.string().email().max(255).nullable().optional(),
  })
  .strict();
export type CreateCustomerInput = z.infer<typeof CreateCustomerInput>;

/** 创建面料样品。 */
export const CreateSampleInput = z
  .object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    composition: z.string().max(255).nullable().optional(),
    weight: z.string().max(64).nullable().optional(),
    unit: Unit.default("meter"),
    costFloor: Money.nullable().optional(),
    status: SampleStatus.default("ACTIVE"),
  })
  .strict();
export type CreateSampleInput = z.infer<typeof CreateSampleInput>;

/** 寄样单行输入（工具层 / 内核共用）。 */
export const CreateSampleShipmentItemInput = z
  .object({
    sampleId: EntityId,
    quantity: Quantity,
  })
  .strict();
export type CreateSampleShipmentItemInput = z.infer<typeof CreateSampleShipmentItemInput>;

/**
 * 创建寄样单（工具 T-005 的输入）。
 * 内核强制落库状态为 DRAFT —— 智能体不能创建已确认的寄样单。
 */
export const CreateSampleShipmentInput = z
  .object({
    customerId: EntityId,
    items: z.array(CreateSampleShipmentItemInput).min(1).max(50),
    channel: ShipmentChannel.default("COURIER"),
    carrier: z.string().max(128).nullable().optional(),
    trackingNumber: z.string().max(128).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type CreateSampleShipmentInput = z.infer<typeof CreateSampleShipmentInput>;

/** 人工确认寄样单。 */
export const ConfirmSampleShipmentInput = z.object({ shipmentId: EntityId }).strict();
export type ConfirmSampleShipmentInput = z.infer<typeof ConfirmSampleShipmentInput>;

/** 人工确认报价草稿（DRAFT -> SENT）。 */
export const ConfirmQuoteInput = z.object({ quoteId: EntityId }).strict();
export type ConfirmQuoteInput = z.infer<typeof ConfirmQuoteInput>;

/** 人类确认报价后的回执：状态只可能是 SENT。 */
export const QuoteConfirmation = z
  .object({
    quoteId: EntityId,
    status: z.literal("SENT"),
    confirmedBy: z.string().min(1).max(128),
    confirmedAt: Timestamp,
  })
  .strict();
export type QuoteConfirmation = z.infer<typeof QuoteConfirmation>;

/** 审计动作：封闭集合，新增动作必须显式加在这里。 */
export const AuditAction = z.enum([
  "CUSTOMER_CREATED",
  "CUSTOMER_CONTEXT_UPDATED",
  "SAMPLE_CREATED",
  "IMPORT_RESET",
  "SAMPLE_SHIPMENT_DRAFTED",
  "SAMPLE_SHIPMENT_CONFIRMED",
  "SAMPLE_SHIPMENT_REJECTED",
  "QUOTE_DRAFT_GENERATED",
  "QUOTE_CONFIRMED",
  "QUOTE_REJECTED",
  /** 用户侧凭据（WAN-78）：账号建立、token 签发、token 撤销。 */
  "USER_CREATED",
  "API_TOKEN_CREATED",
  "API_TOKEN_REVOKED",
]);
export type AuditAction = z.infer<typeof AuditAction>;

/** 审计日志读取模型（只读，不可能由调用方写入）。 */
export const AuditLogEntry = z
  .object({
    id: EntityId,
    seq: z.number().int().positive(),
    actorType: z.enum(["AGENT", "HUMAN", "SYSTEM"]),
    actorId: z.string().min(1).max(128),
    action: AuditAction,
    entityType: z.string().min(1).max(64),
    entityId: EntityId,
    before: JsonValueSchema.nullable(),
    after: JsonValueSchema.nullable(),
    correlationId: EntityId.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;
