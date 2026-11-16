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
import { MemberRole } from "./tenancy";
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

/**
 * 人类新建客户的 HTTP 请求体。
 *
 * 与内核输入的唯一差别：`code` 可以省略，由服务端按北京时间生成
 * `CYYMMDD-NNNN`（并发撞码时重试）。租户与归属人一律由登录态注入，
 * 因此这里也不接受这两个字段（`.strict()` 会直接拒绝）。
 */
export const CreateCustomerRequest = CreateCustomerInput.extend({
  code: z.string().min(1).max(64).optional(),
}).strict();
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;

/** 样品图片 objectKey 列表（已上传到对象存储、属于本租户）。 */
export const SampleImageKeyList = z.array(z.string().min(1).max(512)).max(20);

/** 创建面料样品。 */
export const CreateSampleInput = z
  .object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    composition: z.string().max(255).nullable().optional(),
    category: z.string().max(64).nullable().optional(),
    weight: z.string().max(64).nullable().optional(),
    unit: Unit.default("meter"),
    costFloor: Money.nullable().optional(),
    status: SampleStatus.default("ACTIVE"),
    /**
     * 已上传成功的图片 objectKey（有序）。
     * 桌面/移动端先直传对象存储，再把 key 交给内核挂到样品上。
     */
    imageKeys: SampleImageKeyList.optional(),
    /** 主图 key；必须在 `imageKeys` 里。缺省时取第一张。 */
    primaryImageKey: z.string().min(1).max(512).nullable().optional(),
  })
  .strict();
export type CreateSampleInput = z.infer<typeof CreateSampleInput>;

/**
 * 更新面料样品（部分字段）。
 * `imageKeys` 提供即为「整组替换」：不在列表里的图片行被移除（对象留待回收任务）。
 */
export const UpdateSampleInput = z
  .object({
    code: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(255).optional(),
    composition: z.string().max(255).nullable().optional(),
    category: z.string().max(64).nullable().optional(),
    weight: z.string().max(64).nullable().optional(),
    unit: Unit.optional(),
    costFloor: Money.nullable().optional(),
    status: SampleStatus.optional(),
    imageKeys: SampleImageKeyList.optional(),
    primaryImageKey: z.string().min(1).max(512).nullable().optional(),
    /**
     * 已有图片的 ID 顺序（整组替换）。读模型不暴露 objectKey，
     * 所以桌面端的排序 / 删除 / 设主图用图片 ID 表达。
     */
    imageIds: z.array(EntityId).max(20).optional(),
    primaryImageId: EntityId.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少需要更新一个字段",
  })
  .refine(
    (value) =>
      value.primaryImageKey === undefined ||
      value.primaryImageKey === null ||
      value.imageKeys === undefined ||
      value.imageKeys.includes(value.primaryImageKey),
    { message: "主图必须包含在 imageKeys 里" },
  )
  .refine((value) => value.imageKeys === undefined || value.imageIds === undefined, {
    message: "imageKeys 与 imageIds 只能二选一",
  })
  .refine(
    (value) =>
      value.primaryImageId === undefined ||
      value.primaryImageId === null ||
      value.imageIds === undefined ||
      value.imageIds.includes(value.primaryImageId),
    { message: "主图必须包含在 imageIds 里" },
  );
export type UpdateSampleInput = z.infer<typeof UpdateSampleInput>;

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
export const ConfirmQuoteInput = z
  .object({
    quoteId: EntityId,
    /** 可选乐观锁：审批人看到的是哪一版就确认哪一版。 */
    baseVersion: z.number().int().positive().optional(),
  })
  .strict();
export type ConfirmQuoteInput = z.infer<typeof ConfirmQuoteInput>;

/** 人类确认报价后的回执：状态只可能是 SENT。 */
export const QuoteConfirmation = z
  .object({
    quoteId: EntityId,
    status: z.literal("SENT"),
    confirmedBy: z.string().min(1).max(128),
    confirmedAt: Timestamp,
    version: z.number().int().positive().optional(),
  })
  .strict();
export type QuoteConfirmation = z.infer<typeof QuoteConfirmation>;

/** 审计动作：封闭集合，新增动作必须显式加在这里。 */
export const AuditAction = z.enum([
  "CUSTOMER_CREATED",
  "CUSTOMER_CONTEXT_UPDATED",
  "SAMPLE_CREATED",
  "SAMPLE_UPDATED",
  "SAMPLE_ARCHIVED",
  "SAMPLE_IMAGE_ADDED",
  /** 导入/重算后补向量失败：导入已提交，需要重跑 reindex。 */
  "SAMPLE_INDEX_FAILED",
  "IMPORT_RESET",
  /** 用户撤销一条「说点什么」意图（10 分钟内）。 */
  "INTENT_CANCELLED",
  "SAMPLE_SHIPMENT_DRAFTED",
  "SAMPLE_SHIPMENT_CONFIRMED",
  "SAMPLE_SHIPMENT_REJECTED",
  "QUOTE_DRAFT_GENERATED",
  "QUOTE_DRAFT_REVISED",
  "QUOTE_REVISION_PROPOSED",
  "QUOTE_APPROVAL_ESCALATED",
  "QUOTE_CONFIRMED",
  "QUOTE_REJECTED",
  "TENANT_CREATED",
  "MEMBERSHIP_CREATED",
  /** 登录后选择 / 运行中切换租户：before.fromTenantId → after.toTenantId。 */
  "TENANT_SWITCHED",
  "MEMBERSHIP_INVITED",
  "MEMBERSHIP_ACTIVATED",
  /** 撤销一条尚未接受的邀请（删除 INVITED membership，邀请票据随之失效）。 */
  "MEMBERSHIP_REVOKED",
  "ORDER_CREATED",
  "ORDER_CONFIRMED",
  "SHIPMENT_CREATED",
  "SHIPMENT_CONFIRMED",
  "RECEIVABLE_CREATED",
  "RECEIVABLE_PAYMENT_RECORDED",
  "QUOTE_SHARE_CREATED",
  "QUOTE_SHARE_REVOKED",
  "REVISION_REQUESTED",
  "REVISION_RESOLVED",
  "DECISION_DELTA_RECORDED",
  "PRICING_POLICY_CREATED",
  "PRICING_POLICY_UPDATED",
  "LLM_SETTINGS_UPDATED",
  // 身份/凭据类动作（网关与打印代理会写入，保持审计动作集合封闭）
  "USER_CREATED",
  "API_TOKEN_CREATED",
  "API_TOKEN_REVOKED",
  "PRINT_AGENT_REGISTERED",
  "PRINT_AGENT_DISABLED",
  "PRINT_TEMPLATE_PUBLISHED",
  "PRINT_JOB_CREATED",
  "PRINT_JOB_COMPLETED",
  "PRINT_JOB_FAILED",
  "PRINT_JOB_CANCELLED",
  "PRINT_BOX_CREATED",
  "PRINT_BOX_VOIDED",
  "PRINT_LABEL_REISSUED",
  "PRINT_DISCREPANCY_FLAGGED",
  "PRINT_SCAN_RECORDED",
]);
export type AuditAction = z.infer<typeof AuditAction>;

/**
 * 审计动作的中文文案。
 *
 * 只收录成员/身份这类「设置页与审计页都要展示」的动作；业务动作的文案
 * 仍由各端自己维护（工作台有上下文，能写出比枚举更具体的一句话）。
 * 未收录的动作由调用方兜底，不得把 SCREAMING_SNAKE 直接放到界面上。
 */
export const AUDIT_ACTION_LABEL: Partial<Record<AuditAction, string>> = {
  TENANT_CREATED: "创建了公司",
  MEMBERSHIP_CREATED: "添加了成员",
  MEMBERSHIP_INVITED: "邀请了成员",
  MEMBERSHIP_ACTIVATED: "成员接受了邀请",
  MEMBERSHIP_REVOKED: "撤销了成员邀请",
};

/** 审计日志读取模型（只读，不可能由调用方写入）。 */
export const AuditLogEntry = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    seq: z.number().int().positive(),
    actorType: z.enum(["AGENT", "HUMAN", "SYSTEM"]),
    actorId: z.string().min(1).max(128),
    /** 审批人当时的角色快照（智能体/系统为空），用于还原审批时点的权限。 */
    actorRole: MemberRole.nullable().optional(),
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
