import { z } from "zod";
import { toolResultSchema } from "../common";
import { Currency, EntityId, Money, Quantity, Timestamp } from "../domain";

/**
 * 报价行输入：智能体建议的单价 + 数量。
 * `unitPrice` 仅作为建议，最终单价 / 总额一律由确定性内核重算并判定。
 */
export const QuoteLineItemInput = z
  .object({
    fabricSampleId: EntityId,
    quantity: Quantity,
    unitPrice: Money,
    notes: z.string().max(500).optional(),
  })
  .strict();
export type QuoteLineItemInput = z.infer<typeof QuoteLineItemInput>;

/** T-004 输入：生成报价草稿。 */
export const T004GenerateQuoteDraftInput = z
  .object({
    customerId: EntityId,
    items: z.array(QuoteLineItemInput).min(1).max(200),
    currency: Currency,
    /** 报价有效期（天） */
    validityDays: z.number().int().positive().max(365).default(30),
    remarks: z.string().max(2000).optional(),
  })
  .strict();
export type T004GenerateQuoteDraftInput = z.infer<typeof T004GenerateQuoteDraftInput>;

/**
 * 报价行（内核计算后的权威值）。
 * `lineTotal` 由确定性内核根据 unitPrice.amount * quantity.value 计算，智能体不得直接填写。
 */
export const QuoteLineItem = z.object({
  fabricSampleId: EntityId,
  description: z.string().min(1).max(255),
  quantity: Quantity,
  unitPrice: Money,
  lineTotal: Money,
});
export type QuoteLineItem = z.infer<typeof QuoteLineItem>;

/**
 * 报价草稿 —— 智能体的输出永远是「草稿 / 建议」状态，
 * 人类在审批窗口确认后，前端调用内核 confirm 接口才正式生效。
 */
export const QuoteDraft = z.object({
  id: EntityId,
  customerId: EntityId,
  status: z.literal("DRAFT"),
  currency: Currency,
  items: z.array(QuoteLineItem).min(1),
  subtotal: Money,
  total: Money,
  /** 契约级断言：金额一律由确定性内核计算，而非 LLM 直接计算。 */
  amountsComputedByKernel: z.literal(true),
  validityDays: z.number().int().positive(),
  expiresAt: Timestamp,
  createdAt: Timestamp,
  remarks: z.string().max(2000).nullable(),
});
export type QuoteDraft = z.infer<typeof QuoteDraft>;

/** T-004 成功数据。 */
export const T004GenerateQuoteDraftData = z.object({
  draft: QuoteDraft,
});
export type T004GenerateQuoteDraftData = z.infer<typeof T004GenerateQuoteDraftData>;

/** T-004 完整结果（成功 / 失败可判别）。 */
export const T004GenerateQuoteDraftResult = toolResultSchema(T004GenerateQuoteDraftData);
export type T004GenerateQuoteDraftResult = z.infer<typeof T004GenerateQuoteDraftResult>;
