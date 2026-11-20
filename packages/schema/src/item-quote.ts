import { z } from "zod";
import { Currency, EntityId, Money, Quantity, QuoteStatus, Timestamp } from "./domain";

/**
 * 事项内的报价闭环契约（P0a-5，旅程 A）。
 *
 * 与报价内核的分工不变：金额仍由内核计算，客户端只提交「想报多少」。
 * 这里只定义事项 ↔ 报价的接线形状与工作面读写模型。
 */

/**
 * 在事项里发起报价。
 *
 * - `quantity` 缺省取事项数量；显式给出时必须与样品单位一致。
 * - `unitPrice` 缺省由内核按成本底线 + 默认毛利给出建议价（T-006 同口径），
 *   前端不自己算钱。
 * - `rawText` 是用户原话，只作为备注留痕，不参与定价（P0 不做文本改价解析）。
 */
export const CreateItemQuoteInput = z
  .object({
    currency: Currency.default("CNY"),
    validityDays: z.number().int().min(1).max(365).default(30),
    unitPrice: Money.optional(),
    quantity: Quantity.optional(),
    remarks: z.string().max(2000).nullable().optional(),
    rawText: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CreateItemQuoteInput = z.infer<typeof CreateItemQuoteInput>;

export const ItemQuoteListResponse = z
  .object({
    quotes: z.array(
      z.object({
        id: EntityId,
        itemId: EntityId.nullable(),
        quoteNumber: z.string().min(1).max(64),
        status: QuoteStatus,
        currency: Currency,
        total: Money,
        version: z.number().int().positive(),
        expiresAt: Timestamp,
        createdAt: Timestamp,
        confirmedBy: z.string().min(1).max(128).nullable(),
        confirmedAt: Timestamp.nullable(),
      }),
    ),
  })
  .strict();
export type ItemQuoteListResponse = z.infer<typeof ItemQuoteListResponse>;

/** 依据抽屉的一行：报价值 vs 成本/毛利，每个数字都带出处。 */
export const QuoteBasisLine = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    sampleId: EntityId,
    sampleCode: z.string().min(1).max(64),
    sampleName: z.string().min(1).max(255),
    quantity: Quantity,
    unitPrice: Money,
    lineTotal: Money,
    /** 样品自身维护的成本底线。 */
    sampleCostFloor: Money,
    /** 公司/品类层生效的成本底线。 */
    companyCostFloor: Money,
    /** 成本底线 + 最低毛利后的实际价格下限。 */
    priceFloor: Money,
    minMarginPct: z.number().nullable(),
    /** 单价 − 成本底线（不是利润会计口径，是报价时的可解释余量）。 */
    marginAmount: Money,
    /** marginAmount / unitPrice，万分之一。 */
    marginBps: z.number().int(),
    floorSource: z.string().min(1).max(255),
  })
  .strict();
export type QuoteBasisLine = z.infer<typeof QuoteBasisLine>;

/** 历史成交来源单据：同一样品最近确认过的报价。 */
export const QuoteBasisHistoryEntry = z
  .object({
    quoteId: EntityId,
    quoteNumber: z.string().min(1).max(64),
    customerName: z.string().min(1).max(255),
    status: QuoteStatus,
    unitPrice: Money,
    quantity: Quantity,
    confirmedAt: Timestamp,
  })
  .strict();
export type QuoteBasisHistoryEntry = z.infer<typeof QuoteBasisHistoryEntry>;

/**
 * 报价依据（`GET /quotes/:id/basis`）。
 *
 * 文档 §10 Q6：P0 实时查，不做缓存。因此这里没有 `cachedAt`，
 * 每次打开抽屉都是当前账本。
 */
export const QuoteBasis = z
  .object({
    quoteId: EntityId,
    itemId: EntityId.nullable(),
    currency: Currency,
    generatedAt: Timestamp,
    lines: z.array(QuoteBasisLine).min(1),
    history: z.array(QuoteBasisHistoryEntry),
    /** 全部行中最近一次成交价（同样品），无历史为 null。 */
    lastDealUnitPrice: Money.nullable(),
    lastDealAt: Timestamp.nullable(),
  })
  .strict();
export type QuoteBasis = z.infer<typeof QuoteBasis>;

/** 改价输入（`POST /quotes/:id/revise`）：只允许改单价与备注，数量沿用原行。 */
export const ReviseQuotePriceLineInput = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    unitPrice: Money,
  })
  .strict();
export type ReviseQuotePriceLineInput = z.infer<typeof ReviseQuotePriceLineInput>;

export const ReviseItemQuoteInput = z
  .object({
    baseVersion: z.number().int().positive(),
    lines: z.array(ReviseQuotePriceLineInput).min(1).max(200),
    note: z.string().max(500).nullable().optional(),
    validityDays: z.number().int().positive().max(365).optional(),
    remarks: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type ReviseItemQuoteInput = z.infer<typeof ReviseItemQuoteInput>;

/**
 * 确认报价（`POST /quotes/:id/confirm`）。
 *
 * 幂等契约：
 * - 带同一个 `idempotencyKey` 重试：返回首次确认结果（200），不新增审计；
 * - 已确认后不带 key（或换 key）再次确认：409，避免把「另一次确认」误当成重试。
 * 并发两次无 key 确认仍然只有一次成功（行锁 + 状态判断）。
 */
export const ConfirmItemQuoteInput = z
  .object({
    baseVersion: z.number().int().positive().optional(),
    /** 幂等键：同一次点击重试必须返回同一结果，不产生第二条确认审计。 */
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict()
  .default({});
export type ConfirmItemQuoteInput = z.infer<typeof ConfirmItemQuoteInput>;

/** 复制文本（`GET /quotes/:id/copy-text`）：纯文本，直接粘进 IM。 */
export const QuoteCopyText = z
  .object({
    quoteId: EntityId,
    quoteNumber: z.string().min(1).max(64),
    customerName: z.string().min(1).max(255),
    sampleNames: z.array(z.string().min(1).max(255)),
    quantityText: z.string().min(1).max(255),
    unitPriceText: z.string().min(1).max(255),
    totalText: z.string().min(1).max(255),
    validityDays: z.number().int().positive(),
    expiresAt: Timestamp,
    text: z.string().min(1).max(4000),
  })
  .strict();
export type QuoteCopyText = z.infer<typeof QuoteCopyText>;

/** 改价后的展示：原价 → 新价 → 差额（金额与百分比都由内核算）。 */
export const QuotePriceChange = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    sampleCode: z.string().min(1).max(64),
    beforeUnitPrice: Money,
    afterUnitPrice: Money,
    delta: Money,
    deltaPctBps: z.number().int(),
    beforeLineTotal: Money,
    afterLineTotal: Money,
  })
  .strict();
export type QuotePriceChange = z.infer<typeof QuotePriceChange>;

export const ItemQuoteRevisionResult = z
  .object({
    quoteId: EntityId,
    version: z.number().int().positive(),
    status: QuoteStatus,
    total: Money,
    changes: z.array(QuotePriceChange).min(1),
  })
  .strict();
export type ItemQuoteRevisionResult = z.infer<typeof ItemQuoteRevisionResult>;
