import { z } from "zod";
import { toolResultSchema } from "./common";
import {
  Currency,
  Customer,
  EntityId,
  FabricSample,
  Money,
  Quantity,
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

/**
 * 审批队列：只含 pending（DRAFT）单据。
 *
 * 游标分页：`nextCursor` 为空表示到最后一页；`hasMore` 是给前端的
 * 「还有更多」提示，两者都由后端计算，前端不得按条数猜测。
 * 字段可选是为了兼容旧 mock / 旧快照，缺失时视为「单页、无更多」。
 */
export const ApprovalQueue = z
  .object({
    items: z.array(ApprovalItem),
    nextCursor: z.string().min(1).max(512).nullable().optional(),
    hasMore: z.boolean().optional(),
  })
  .strict();
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

/**
 * 工作台动态流的一条业务事件。
 *
 * 动态流不是审计流水的直出：只有人 / 智能体发起、且动作落在业务白名单里
 * 的账本记录才会投影成事件。系统初始化（建公司、加成员、存设置）留在
 * 全景的 `audit` 里给审计页用，不进这里。
 *
 * `actorLabel` 由后端给定（人 = 你/同事，智能体 = 小织/小跟/小序），
 * 前端不再按动作前缀猜是谁做的。`summary` 是后端写好的中文短句，
 * 保证页面上永远不会出现 SCREAMING_SNAKE 枚举。
 */
export const PanoramaEventKind = z.enum(["AGENT_DONE", "AGENT_RUNNING", "HUMAN_DONE", "MILESTONE"]);
export type PanoramaEventKind = z.infer<typeof PanoramaEventKind>;

export const PanoramaEvent = z
  .object({
    id: EntityId,
    eventKind: PanoramaEventKind,
    actorType: z.enum(["AGENT", "HUMAN"]),
    actorLabel: z.string().min(1).max(64),
    /** 业务动作（白名单内的审计动作；运行中事件由意图通道给出自己的 kind）。 */
    action: z.string().min(1).max(64),
    /** 中文短句，例如「生成了报价草稿」，后端已做过映射与兜底。 */
    summary: z.string().min(1).max(120),
    entityType: z.string().min(1).max(64),
    entityId: EntityId,
    createdAt: Timestamp,
  })
  .strict();
export type PanoramaEvent = z.infer<typeof PanoramaEvent>;

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
    /** 最近审计条数：仅供审计页，不能当「今天智能体做了多少事」。 */
    auditCount: z.number().int().nonnegative(),
    /** 今天（业务时区）智能体完成的业务动作数，标题用它，不用 auditCount。 */
    todayAgentDoneCount: z.number().int().nonnegative().default(0),
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
    /** 业务事件流投影（已分型、已过滤、已给中文文案）。 */
    events: z.array(PanoramaEvent).default([]),
    stats: PanoramaStats,
  })
  .strict();
export type PanoramaSnapshot = z.infer<typeof PanoramaSnapshot>;

/**
 * 审批卡详情（只读）：审批窗口点开一条单据时的一次性聚合。
 *
 * 这是「出处 + 生效值来源 + diff」的 HTTP 契约。所有字段都由后端只读聚合，
 * 前端不得自行推导金额、风险或 diff。缺失项不是错误，用中性提示，不用红色。
 */

/** 草稿态是产品最重要的视觉状态；后端给出权威状态，前端只负责统一渲染。 */
export const ApprovalDraftState = z.enum(["DRAFT", "CONFIRMED", "REJECTED", "FAILED"]);
export type ApprovalDraftState = z.infer<typeof ApprovalDraftState>;

export const ApprovalDraftMeta = z
  .object({
    state: ApprovalDraftState,
    /** 草稿版本号；修订一次 +1。 */
    version: z.number().int().nonnegative(),
    /** 人类是否改过这份草稿（决定卡片是否显示「你改过 N 处」）。 */
    revisedByHuman: z.boolean(),
    /** 修订次数，等于 diff 的批次数；0 表示智能体原稿。 */
    revisionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ApprovalDraftMeta = z.infer<typeof ApprovalDraftMeta>;

/** 审批卡上的一行（报价行 / 寄样行），金额一律来自后端。 */
export const ApprovalLine = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1).max(255),
    quantity: Quantity,
    unitPrice: Money,
    lineTotal: Money,
  })
  .strict();
export type ApprovalLine = z.infer<typeof ApprovalLine>;

/** 出处类型：决定 chip 的图标与展开内容。 */
export const ProvenanceKind = z.enum([
  "HISTORY",
  "COST",
  "STOCK",
  "POLICY",
  "CUSTOMER",
  "AGENT",
  "AUDIT",
]);
export type ProvenanceKind = z.infer<typeof ProvenanceKind>;

/**
 * 一条出处：每个数字都可点开看来源。
 * `value` 是卡片上直接展示的短值，`detail` 是展开后的解释。
 */
export const ApprovalProvenance = z
  .object({
    id: z.string().min(1),
    kind: ProvenanceKind,
    label: z.string().min(1).max(64),
    value: z.string().min(1).max(255),
    detail: z.string().max(2000).nullable(),
    /** 可选的深链（历史报价/客户页）；前端只做站内跳转。 */
    sourceRef: z.string().max(512).nullable(),
  })
  .strict();
export type ApprovalProvenance = z.infer<typeof ApprovalProvenance>;

/** 缺失项：待补不是错误，用黄色徽标配「补一下就能继续」。 */
export const ApprovalMissingField = z
  .object({
    field: z.string().min(1).max(128),
    label: z.string().min(1).max(128),
    hint: z.string().max(255).nullable(),
  })
  .strict();
export type ApprovalMissingField = z.infer<typeof ApprovalMissingField>;

/** 风险等级与理由。理由必须是可由内核核验的事实，不给置信度百分比。 */
export const ApprovalRisk = z
  .object({
    level: z.enum(["LOW", "MEDIUM", "HIGH"]),
    reasons: z.array(z.string().min(1).max(255)),
  })
  .strict();
export type ApprovalRisk = z.infer<typeof ApprovalRisk>;

export const ApprovalDetail = z
  .object({
    item: ApprovalItem,
    customer: Customer.nullable(),
    draft: ApprovalDraftMeta,
    lines: z.array(ApprovalLine),
    subtotal: Money.nullable(),
    total: Money.nullable(),
    currency: Currency,
    provenance: z.array(ApprovalProvenance),
    diffs: z.array(RevisionDiff),
    missingFields: z.array(ApprovalMissingField),
    risk: ApprovalRisk,
    /** 最近审计，证明「每一步都有记录」。 */
    audit: z.array(AuditLogEntry),
  })
  .strict();
export type ApprovalDetail = z.infer<typeof ApprovalDetail>;
