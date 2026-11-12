import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";

/**
 * 报价分享契约（E3 客户报价链接页，T0 冻结）。
 *
 * 安全铁律：数据库只存 `tokenHash`，明文 token 只在创建那一刻返回；
 * 客户视图绝不包含成本 / 毛利 / 内部备注 / 其他客户。
 */

export const QuoteShareEventType = z.enum([
  "VIEWED",
  "PDF_DOWNLOADED",
  "ACCEPTED",
  "QUESTION_ASKED",
  "REVOKED",
]);
export type QuoteShareEventType = z.infer<typeof QuoteShareEventType>;

export const QuoteShare = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    quoteId: EntityId,
    /** 分享时锁定的报价版本号。 */
    version: z.number().int().positive(),
    tokenHash: z.string().min(32).max(128),
    expiresAt: Timestamp,
    requirePhoneTail: z.boolean(),
    allowPdf: z.boolean(),
    revokedAt: Timestamp.nullable(),
    createdBy: z.string().min(1).max(128),
    createdAt: Timestamp,
  })
  .strict();
export type QuoteShare = z.infer<typeof QuoteShare>;

export const QuoteShareEvent = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    shareId: EntityId,
    event: QuoteShareEventType,
    meta: JsonValueSchema.nullable(),
    ipHash: z.string().max(128).nullable(),
    uaHash: z.string().max(128).nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type QuoteShareEvent = z.infer<typeof QuoteShareEvent>;

export const CreateQuoteShareInput = z
  .object({
    quoteId: EntityId,
    expiresInDays: z.number().int().positive().max(90).default(14),
    requirePhoneTail: z.boolean().default(false),
    allowPdf: z.boolean().default(true),
  })
  .strict();
export type CreateQuoteShareInput = z.infer<typeof CreateQuoteShareInput>;

/** 创建分享的返回：明文 token 只出现这一次。 */
export const CreatedQuoteShare = z
  .object({
    share: QuoteShare,
    token: z.string().min(32).max(256),
    url: z.string().url(),
  })
  .strict();
export type CreatedQuoteShare = z.infer<typeof CreatedQuoteShare>;

export const RevokeQuoteShareInput = z.object({ shareId: EntityId }).strict();
export type RevokeQuoteShareInput = z.infer<typeof RevokeQuoteShareInput>;

/** 客户视图（公开路由）——刻意只含客户可见字段。 */
export const CustomerQuoteView = z
  .object({
    shareToken: z.string().min(32).max(256),
    quoteNumber: z.string().min(1).max(64),
    tenantName: z.string().min(1).max(255),
    customerName: z.string().min(1).max(255),
    currency: z.enum(["CNY", "USD", "EUR", "HKD"]),
    lines: z.array(
      z
        .object({
          description: z.string().min(1).max(255),
          quantity: z.number().positive(),
          unit: z.enum(["meter", "kilogram", "yard", "piece"]),
          unitPriceAmount: z.number().int().nonnegative(),
          lineTotalAmount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    subtotalAmount: z.number().int().nonnegative(),
    totalAmount: z.number().int().nonnegative(),
    expiresAt: Timestamp,
    allowPdf: z.boolean(),
  })
  .strict();
export type CustomerQuoteView = z.infer<typeof CustomerQuoteView>;
