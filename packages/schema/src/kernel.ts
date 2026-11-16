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
 * 工作台动态流只展示「业务动作」。建公司、加成员、改 LLM 设置这类系统
 * 初始化事件属于「最近审计」，不是任何人或智能体的业务成果，混进动态流会
 * 让新用户以为系统替他干了活。
 */
export const BUSINESS_AUDIT_ACTIONS = [
  "CUSTOMER_CREATED",
  "CUSTOMER_CONTEXT_UPDATED",
  "SAMPLE_CREATED",
  "SAMPLE_UPDATED",
  "SAMPLE_ARCHIVED",
  "SAMPLE_IMAGE_ADDED",
  "IMPORT_RESET",
  "SAMPLE_SHIPMENT_DRAFTED",
  "SAMPLE_SHIPMENT_CONFIRMED",
  "SAMPLE_SHIPMENT_REJECTED",
  "QUOTE_DRAFT_GENERATED",
  "QUOTE_DRAFT_REVISED",
  "QUOTE_REVISION_PROPOSED",
  "QUOTE_APPROVAL_ESCALATED",
  "QUOTE_CONFIRMED",
  "QUOTE_REJECTED",
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
] as const satisfies readonly AuditAction[];

export type BusinessAuditAction = (typeof BUSINESS_AUDIT_ACTIONS)[number];

export function isBusinessAuditAction(action: AuditAction): action is BusinessAuditAction {
  return (BUSINESS_AUDIT_ACTIONS as readonly string[]).includes(action);
}

/** 动态流里「谁做的」：人类由调用方按当前身份判断，智能体按动作归属。 */
export const AGENT_LABEL = {
  QUOTING: "小织",
  FOLLOWUP: "小跟",
  OPS: "小序",
} as const;

export type AgentLabel = (typeof AGENT_LABEL)[keyof typeof AGENT_LABEL];

/** 动作 → 执行智能体。未列入的动作归到小序（业务运营），但绝不返回原始枚举。 */
export function agentLabelForAction(action: string): AgentLabel {
  if (
    action.startsWith("QUOTE") ||
    action.startsWith("REVISION") ||
    action === "DECISION_DELTA_RECORDED" ||
    action.startsWith("PRICING_POLICY")
  ) {
    return AGENT_LABEL.QUOTING;
  }
  if (
    action.startsWith("SAMPLE_SHIPMENT") ||
    action.startsWith("SHIPMENT") ||
    action === "SAMPLE_ARCHIVED" ||
    action === "SAMPLE_IMAGE_ADDED"
  ) {
    return AGENT_LABEL.FOLLOWUP;
  }
  return AGENT_LABEL.OPS;
}

/** 审计动作的中文说明：单一事实源，web / mobile / 审批卡共用，绝不直出枚举。 */
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  CUSTOMER_CREATED: "新建了客户",
  CUSTOMER_CONTEXT_UPDATED: "更新了客户偏好",
  SAMPLE_CREATED: "新建了样品",
  SAMPLE_UPDATED: "更新了样品",
  SAMPLE_ARCHIVED: "归档了样品",
  SAMPLE_IMAGE_ADDED: "补了样品图片",
  SAMPLE_INDEX_FAILED: "样品索引失败",
  IMPORT_RESET: "重置了导入数据",
  SAMPLE_SHIPMENT_DRAFTED: "生成了寄样单草稿",
  SAMPLE_SHIPMENT_CONFIRMED: "寄样单已确认",
  SAMPLE_SHIPMENT_REJECTED: "寄样单被驳回",
  QUOTE_DRAFT_GENERATED: "生成了报价草稿",
  QUOTE_DRAFT_REVISED: "改了报价草稿",
  QUOTE_REVISION_PROPOSED: "提出了改稿",
  QUOTE_APPROVAL_ESCALATED: "报价升级复核",
  QUOTE_CONFIRMED: "报价已批准生效",
  QUOTE_REJECTED: "报价被驳回",
  TENANT_CREATED: "开了新公司",
  MEMBERSHIP_CREATED: "添加了成员",
  TENANT_SWITCHED: "切换了公司",
  MEMBERSHIP_INVITED: "发出了成员邀请",
  MEMBERSHIP_ACTIVATED: "成员已接受邀请",
  ORDER_CREATED: "创建了订单",
  ORDER_CONFIRMED: "订单已确认",
  SHIPMENT_CREATED: "建了发货单",
  SHIPMENT_CONFIRMED: "发货单已确认",
  RECEIVABLE_CREATED: "建了应收",
  RECEIVABLE_PAYMENT_RECORDED: "登记了回款",
  QUOTE_SHARE_CREATED: "生成了报价分享",
  QUOTE_SHARE_REVOKED: "撤销了报价分享",
  REVISION_REQUESTED: "发起了改稿",
  REVISION_RESOLVED: "处理了改稿",
  DECISION_DELTA_RECORDED: "记录了决策偏好",
  PRICING_POLICY_CREATED: "建了价格政策",
  PRICING_POLICY_UPDATED: "改了价格政策",
  LLM_SETTINGS_UPDATED: "更新了模型设置",
  USER_CREATED: "创建了账号",
  API_TOKEN_CREATED: "创建了访问令牌",
  API_TOKEN_REVOKED: "吊销了访问令牌",
  PRINT_AGENT_REGISTERED: "注册了打印代理",
  PRINT_AGENT_DISABLED: "停用了打印代理",
  PRINT_TEMPLATE_PUBLISHED: "发布了打印模板",
  PRINT_JOB_CREATED: "发起了打印任务",
  PRINT_JOB_COMPLETED: "打印任务完成",
  PRINT_JOB_FAILED: "打印任务失败",
  PRINT_JOB_CANCELLED: "取消了打印任务",
  PRINT_BOX_CREATED: "建了箱",
  PRINT_BOX_VOIDED: "作废了箱",
  PRINT_LABEL_REISSUED: "补打了标签",
  PRINT_DISCREPANCY_FLAGGED: "标记了发货差异",
  PRINT_SCAN_RECORDED: "记录了扫码",
};

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTION_LABEL as Record<string, string>)[action] ?? "更新了业务数据";
}

/** 「谁做的」的中文说明；人类的具体姓名由调用方更好的话再覆盖。 */
export const ACTOR_TYPE_LABEL = {
  AGENT: "智能体",
  HUMAN: "人工",
  SYSTEM: "系统",
} as const;

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
