import { z } from "zod";
import { toolResultSchema } from "./common";
import {
  Currency,
  Customer,
  EntityId,
  FabricSample,
  QuoteStatus,
  SampleShipmentStatus,
  Timestamp,
} from "./domain";
import { AuditLogEntry } from "./kernel";
import { ApprovalLevel, ApprovalRequirement, EscalationReason } from "./pricing";
import { RevisionDiff } from "./revisions";
import { MemberRole } from "./tenancy";

/**
 * 第五步：审批窗口与业务全景的契约。
 *
 * 铁律：智能体产出永远停在 DRAFT / 建议态；审批窗口的「批准 / 拒绝」由前端
 * 调用 approval API，再由 approval 服务调内核 confirm / reject 落账。前端拿到的
 * 永远是「只读视图」和「决策回执」，没有任何写业务表 / 直连内核的能力。
 */

/** 待审批单据的种类：报价草稿 / 寄样单草稿。 */
export const ApprovalKind = z.enum(["quote", "sample_shipment"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/** 人类在审批窗口的两种决策。 */
export const ApprovalDecision = z.enum(["APPROVE", "REJECT"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * 审批队列 / 全景里的一条业务单据（只读视图模型）。
 * 状态取自账本（报价 / 寄样单状态枚举），pending 由 status === "DRAFT" 派生。
 */
export const ApprovalItem = z
  .object({
    id: EntityId,
    kind: ApprovalKind,
    title: z.string().min(1).max(128),
    summary: z.string().min(1).max(255),
    status: z.union([QuoteStatus, SampleShipmentStatus]),
    pending: z.boolean(),
    amountCents: z.number().int().nullable(),
    currency: Currency.nullable(),
    customerId: EntityId,
    createdAt: Timestamp,
    confirmedBy: z.string().max(128).nullable(),
    /** 报价草稿版本（寄样单为 null）。 */
    version: z.number().int().positive().nullable().optional(),
    /** 这条单据需要谁来批；由内核按金额 + 改幅阈值算出。 */
    requiredRole: MemberRole.nullable().optional(),
    requiredLevel: ApprovalLevel.nullable().optional(),
    /** 是否因改幅/金额超阈值被自动升级。 */
    escalated: z.boolean().optional(),
    escalationReasons: z.array(EscalationReason).optional(),
    /** 相对原稿的改幅（万分之一），无改稿为 null。 */
    changePctBps: z.number().int().nonnegative().nullable().optional(),
    /** 原稿 vs 当前版本的逐行 diff，审批卡直接渲染。 */
    diff: z.array(RevisionDiff).optional(),
    /** 生效值与来源（阈值策略、成本底线、毛利规则）。 */
    requirement: ApprovalRequirement.nullable().optional(),
  })
  .strict();
export type ApprovalItem = z.infer<typeof ApprovalItem>;
export type ApprovalItemStatus = ApprovalItem["status"];

/** 审批队列：只含 pending（DRAFT）单据。 */
export const ApprovalQueue = z.object({ items: z.array(ApprovalItem) }).strict();
export type ApprovalQueue = z.infer<typeof ApprovalQueue>;

/** 审批决策入参。note 用于驳回时的异常分诊备注，只进审计、不进业务字段。 */
export const ApprovalDecisionInput = z
  .object({
    id: EntityId,
    kind: ApprovalKind,
    decision: ApprovalDecision,
    note: z.string().max(500).optional(),
    /** 驳回时的结构化原因（revision_reasons.id），用于决策增量。 */
    reasonId: EntityId.optional(),
    /** 审批人看到的是哪一版草稿；与账本不一致时内核拒绝（并发保护）。 */
    baseVersion: z.number().int().positive().optional(),
  })
  .strict();
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInput>;

/** 决策回执：actorType 固定 HUMAN，强调「生效只能来自人类审批」。 */
export const ApprovalDecisionOutcome = z
  .object({
    id: EntityId,
    kind: ApprovalKind,
    decision: ApprovalDecision,
    status: ApprovalItem.shape.status,
    actorType: z.literal("HUMAN"),
    decidedAt: Timestamp,
  })
  .strict();
export type ApprovalDecisionOutcome = z.infer<typeof ApprovalDecisionOutcome>;

/** 决策结果沿用工具层统一的 ok/error 可判别联合，失败语义不另起一套。 */
export const ApprovalDecisionResult = toolResultSchema(ApprovalDecisionOutcome);
export type ApprovalDecisionResult = z.infer<typeof ApprovalDecisionResult>;

/** 全景仪表盘的统计计数（全部由后端只读聚合，前端不做业务计算）。 */
export const PanoramaStats = z
  .object({
    customerCount: z.number().int().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
    quoteCount: z.number().int().nonnegative(),
    shipmentCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    sentQuoteCount: z.number().int().nonnegative(),
    confirmedShipmentCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
    auditCount: z.number().int().nonnegative(),
  })
  .strict();
export type PanoramaStats = z.infer<typeof PanoramaStats>;

/** 业务全景（只读）：一次拉取，前端纯展示，不提供任何写操作。 */
export const PanoramaSnapshot = z
  .object({
    generatedAt: Timestamp,
    customers: z.array(Customer),
    samples: z.array(FabricSample),
    items: z.array(ApprovalItem),
    audit: z.array(AuditLogEntry),
    stats: PanoramaStats,
  })
  .strict();
export type PanoramaSnapshot = z.infer<typeof PanoramaSnapshot>;
