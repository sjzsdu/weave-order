import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";

/**
 * 改稿 / 审批修订契约（T0 冻结）。
 *
 * `revision_requests` 是一次「人类要求改」的意图；
 * `draft_revisions` 是内核算出的可回放补丁版本；
 * `revision_reasons` 是结构化原因字典（价格/交期/规格/客户要求/其他）。
 *
 * 铁律 G10：AI 只能产出草稿，patch 必须由人批准后才经内核 confirm 生效。
 */

/** 可改稿的实体类型。 */
export const RevisionEntityType = z.enum(["quote", "order", "sample_shipment"]);
export type RevisionEntityType = z.infer<typeof RevisionEntityType>;

/** 改稿来源：行内编辑 / 表单 / Chat。 */
export const RevisionSource = z.enum(["INLINE", "FORM", "CHAT"]);
export type RevisionSource = z.infer<typeof RevisionSource>;

export const RevisionRequestStatus = z.enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]);
export type RevisionRequestStatus = z.infer<typeof RevisionRequestStatus>;

/** 结构化改稿原因。 */
export const RevisionReason = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(255),
    appliesTo: z.array(RevisionEntityType),
    active: z.boolean(),
    sortOrder: z.number().int(),
  })
  .strict();
export type RevisionReason = z.infer<typeof RevisionReason>;

/** 新建结构化改稿/驳回原因（价格/交期/规格/客户要求/其他）。 */
export const CreateRevisionReasonInput = z
  .object({
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(255),
    appliesTo: z.array(RevisionEntityType).min(1),
    active: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  })
  .strict();
export type CreateRevisionReasonInput = z.infer<typeof CreateRevisionReasonInput>;

/**
 * 草稿修订版本：保存 before/after/patch/provenance。
 * `version` 在同一实体上单调递增，用于并发冲突检测。
 */
export const DraftRevision = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    revisionRequestId: EntityId.nullable(),
    entityType: RevisionEntityType,
    entityId: EntityId,
    version: z.number().int().positive(),
    patch: JsonValueSchema,
    before: JsonValueSchema,
    after: JsonValueSchema,
    /** 出处：哪个智能体 / 哪条指令 / 用了什么数据。 */
    provenance: JsonValueSchema,
    actorType: z.enum(["AGENT", "HUMAN", "SYSTEM"]),
    actorId: z.string().min(1).max(128),
    createdAt: Timestamp,
  })
  .strict();
export type DraftRevision = z.infer<typeof DraftRevision>;

/** 改稿请求。 */
export const RevisionRequest = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    entityType: RevisionEntityType,
    entityId: EntityId,
    source: RevisionSource,
    instruction: z.string().min(1).max(4000),
    patch: JsonValueSchema,
    status: RevisionRequestStatus,
    /** 兼容旧客户端的通用决策字段；与 status 二选一，禁止同时用。 */
    decision: z.enum(["APPROVE", "REJECT"]).nullable(),
    reasonId: EntityId.nullable(),
    baseVersion: z.number().int().nonnegative(),
    requestedByType: z.enum(["AGENT", "HUMAN", "SYSTEM"]),
    requestedById: z.string().min(1).max(128),
    resolvedBy: z.string().max(128).nullable(),
    resolvedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type RevisionRequest = z.infer<typeof RevisionRequest>;

/** 创建改稿请求（AI 或人类发起，均落 PENDING）。 */
export const CreateRevisionRequestInput = z
  .object({
    entityType: RevisionEntityType,
    entityId: EntityId,
    source: RevisionSource,
    instruction: z.string().min(1).max(4000),
    patch: JsonValueSchema,
    reasonId: EntityId.nullable().optional(),
    baseVersion: z.number().int().nonnegative(),
  })
  .strict();
export type CreateRevisionRequestInput = z.infer<typeof CreateRevisionRequestInput>;

/** 人类裁决改稿请求。 */
export const DecideRevisionRequestInput = z
  .object({
    revisionRequestId: EntityId,
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().max(500).optional(),
  })
  .strict();
export type DecideRevisionRequestInput = z.infer<typeof DecideRevisionRequestInput>;

/** 供审批卡渲染的 diff 片段。 */
export const RevisionDiff = z
  .object({
    field: z.string().min(1).max(255),
    before: JsonValueSchema,
    after: JsonValueSchema,
    /** 报价行改价时为 0-based 行号；单据级字段为 null。 */
    lineIndex: z.number().int().nonnegative().nullable().optional(),
    /** 人类可读字段名，如「单价」「数量」。 */
    label: z.string().max(128).nullable().optional(),
  })
  .strict();
export type RevisionDiff = z.infer<typeof RevisionDiff>;
