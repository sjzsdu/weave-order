import { z } from "zod";
import { toolResultSchema } from "../common";
import { Currency, EntityId, Money, Quantity } from "../domain";

/**
 * 定价依据的一条成分：每个数字都能点回来源（成本底线 / 客户等级 / 取整）。
 * 金额一律整数分，比例用 basis points（1% = 100bp），避免浮点。
 */
export const PricingBasisComponent = z
  .object({
    kind: z.enum(["COST_FLOOR", "CUSTOMER_TIER_MARKUP", "ROUNDING", "POLICY"]),
    label: z.string().min(1).max(128),
    /** 该成分的金额（可为空：比例类成分只描述比例）。 */
    amount: Money.nullable(),
    /** 比例（basis points），非比例成分为 null。 */
    rateBps: z.number().int().nonnegative().nullable(),
    /** 来源：sample.costFloor / customer.tier / rounding / policy 等。 */
    source: z.string().min(1).max(255),
    note: z.string().max(500).nullable(),
  })
  .strict();
export type PricingBasisComponent = z.infer<typeof PricingBasisComponent>;

/** 确定性定价结果：智能体只能引用它，不能自己算金额。 */
export const QuotePricingBasis = z
  .object({
    customerId: EntityId,
    fabricSampleId: EntityId,
    currency: Currency,
    quantity: Quantity,
    costFloor: Money.nullable(),
    markupRateBps: z.number().int().nonnegative(),
    suggestedUnitPrice: Money,
    components: z.array(PricingBasisComponent).min(1).max(20),
    computedBy: z.literal("KERNEL"),
  })
  .strict();
export type QuotePricingBasis = z.infer<typeof QuotePricingBasis>;

export const T006SuggestLinePriceInput = z
  .object({
    customerId: EntityId,
    fabricSampleId: EntityId,
    quantity: Quantity,
    currency: Currency,
  })
  .strict();
export type T006SuggestLinePriceInput = z.infer<typeof T006SuggestLinePriceInput>;

export const T006SuggestLinePriceData = z.object({ pricing: QuotePricingBasis }).strict();
export type T006SuggestLinePriceData = z.infer<typeof T006SuggestLinePriceData>;

export const T006SuggestLinePriceResult = toolResultSchema(T006SuggestLinePriceData);
export type T006SuggestLinePriceResult = z.infer<typeof T006SuggestLinePriceResult>;
