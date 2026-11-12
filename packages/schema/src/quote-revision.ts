import { z } from "zod";
import { toolResultSchema } from "./common";
import { EntityId, JsonValueSchema, Money, Quantity, Timestamp } from "./domain";
import { ApprovalRequirement } from "./pricing";
import { DraftRevision, RevisionDiff, RevisionEntityType, RevisionSource } from "./revisions";
import { QuoteDraft } from "./tools/t004-generate-quote-draft";

/**
 * 报价改稿契约（Track A 增量，向后兼容）。
 *
 * 所有入口（行内编辑 / 调整面板 / Chat）最终都走内核 `reviseDraft`：
 * - 版本 +1（乐观锁：baseVersion 不匹配直接拒绝）
 * - 金额由内核重算
 * - 同事务写审计 + draft_revisions + decision_deltas
 * - 改幅超阈值时自动升级审批人
 *
 * AI 只产出 Patch，不直接改账本：`reviseDraft` 要求 HUMAN actor；
 * AGENT 生成的 patch 走 `proposeRevision`，停在 PENDING 等人类裁决。
 */

/** 单行修改：只给要改的字段，未给的字段保持不变。 */
export const ReviseQuoteLineInput = z
  .object({
    /** 0-based 行号，必须命中当前草稿的一行。 */
    lineIndex: z.number().int().nonnegative(),
    /** 换样品时给新样品 ID。 */
    fabricSampleId: EntityId.optional(),
    quantity: Quantity.optional(),
    /** 人工修改后的单价；内核仍会做币种 / 单位 / 成本底线校验。 */
    unitPrice: Money.optional(),
    description: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.fabricSampleId !== undefined ||
      value.quantity !== undefined ||
      value.unitPrice !== undefined ||
      value.description !== undefined,
    { message: "每行修改至少要改一个字段" },
  );
export type ReviseQuoteLineInput = z.infer<typeof ReviseQuoteLineInput>;

/** 人类改稿输入。 */
export const ReviseQuoteDraftInput = z
  .object({
    quoteId: EntityId,
    /** 客户端读到的草稿版本；与账本不一致时拒绝，避免覆盖别人的修改。 */
    baseVersion: z.number().int().positive(),
    source: RevisionSource,
    /** 改稿指令原文（Chat 时为自然语言，行内编辑时可写「改单价」）。 */
    instruction: z.string().min(1).max(4000),
    /** 结构化原因（revision_reasons.id）。 */
    reasonId: EntityId.nullable().optional(),
    lines: z.array(ReviseQuoteLineInput).min(1).max(200).optional(),
    validityDays: z.number().int().positive().max(365).optional(),
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.lines !== undefined || value.validityDays !== undefined || value.remarks !== undefined,
    { message: "改稿至少要修改一个字段" },
  );
export type ReviseQuoteDraftInput = z.infer<typeof ReviseQuoteDraftInput>;

/** 改稿结果：新草稿 + 可回放版本 + 逐行 diff + 审批要求。 */
export const QuoteRevisionData = z
  .object({
    draft: QuoteDraft,
    revision: DraftRevision,
    diff: z.array(RevisionDiff),
    requirement: ApprovalRequirement,
    /** 改后是否需要升级到更高层级审批。 */
    escalated: z.boolean(),
  })
  .strict();
export type QuoteRevisionData = z.infer<typeof QuoteRevisionData>;

export const ReviseQuoteDraftResult = toolResultSchema(QuoteRevisionData);
export type ReviseQuoteDraftResult = z.infer<typeof ReviseQuoteDraftResult>;

/** 报价行在审批视图里的只读形态：展示 + 出处。 */
export const QuoteApprovalLine = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    sampleId: EntityId,
    description: z.string().min(1).max(255),
    quantity: Quantity,
    unitPrice: Money,
    lineTotal: Money,
    provenance: JsonValueSchema,
  })
  .strict();
export type QuoteApprovalLine = z.infer<typeof QuoteApprovalLine>;

/**
 * 审批卡详情（只读）：原稿 → 当前版本的逐行 diff + 每个数字的出处。
 * 前端不做任何业务计算，金额与 diff 全部由内核给出。
 */
export const QuoteApprovalView = z
  .object({
    quoteId: EntityId,
    version: z.number().int().positive(),
    status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]),
    customerId: EntityId,
    currency: z.enum(["CNY", "USD", "EUR", "HKD"]),
    subtotal: Money,
    total: Money,
    items: z.array(QuoteApprovalLine),
    diff: z.array(RevisionDiff),
    requirement: ApprovalRequirement,
    revisions: z.array(DraftRevision),
    updatedAt: Timestamp,
  })
  .strict();
export type QuoteApprovalView = z.infer<typeof QuoteApprovalView>;

/** 改稿来源与实体类型保持一致（报价改稿固定 entityType=quote）。 */
export const QuoteRevisionEntityType = RevisionEntityType.extract(["quote"]);
export type QuoteRevisionEntityType = z.infer<typeof QuoteRevisionEntityType>;
