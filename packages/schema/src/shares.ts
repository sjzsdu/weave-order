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

/**
 * 客户页的完整读取模型：客户视图 + 页面级元数据。
 * `view` 之外的字段都只描述「这条链接」本身，不携带任何内部业务数据。
 */
export const CustomerQuotePage = z
  .object({
    view: CustomerQuoteView,
    acceptedAt: Timestamp.nullable(),
    remainingDays: z.number().int().nonnegative(),
    requirePhoneTail: z.boolean(),
    salesName: z.string().min(1).max(255).nullable(),
    terms: z.string().max(2000).nullable(),
  })
  .strict();
export type CustomerQuotePage = z.infer<typeof CustomerQuotePage>;

/** 客户接受报价：只产生成交意向，不改账本。手机尾号按分享设置可选校验。 */
export const CustomerAcceptQuoteInput = z
  .object({
    phoneTail: z
      .string()
      .regex(/^\d{4}$/, "手机尾号必须是 4 位数字")
      .optional(),
  })
  .strict();
export type CustomerAcceptQuoteInput = z.infer<typeof CustomerAcceptQuoteInput>;

export const CustomerAcceptQuoteResult = z
  .object({
    acceptedAt: Timestamp,
    alreadyAccepted: z.boolean(),
    /** 接受 ≠ 合同：前端必须原样展示这句提示。 */
    nextStep: z.string().min(1).max(255),
  })
  .strict();
export type CustomerAcceptQuoteResult = z.infer<typeof CustomerAcceptQuoteResult>;

/** 客户在任意行留言提问（进入业务员/小织的消息队列）。 */
export const CustomerAskQuestionInput = z
  .object({
    message: z.string().trim().min(1).max(1000),
    lineIndex: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type CustomerAskQuestionInput = z.infer<typeof CustomerAskQuestionInput>;

export const CustomerAskQuestionResult = z
  .object({
    eventId: EntityId,
    createdAt: Timestamp,
  })
  .strict();
export type CustomerAskQuestionResult = z.infer<typeof CustomerAskQuestionResult>;

/** 客户侧可读的失败原因；HTTP 状态由控制器映射（410 过期/撤回，400 校验失败）。 */
export const QuoteLinkErrorCode = z.enum([
  "INVALID_LINK",
  "INVALID_INPUT",
  "EXPIRED",
  "REVOKED",
  "PHONE_TAIL_REQUIRED",
  "PHONE_TAIL_MISMATCH",
  "PDF_DISABLED",
]);
export type QuoteLinkErrorCode = z.infer<typeof QuoteLinkErrorCode>;

export const QuoteLinkError = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: QuoteLinkErrorCode,
        message: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();
export type QuoteLinkError = z.infer<typeof QuoteLinkError>;

/** 业务员看到的单条分享访问数据：谁看了、看几次、接受没有、问了什么。 */
export const QuoteShareQuestion = z
  .object({
    eventId: EntityId,
    message: z.string().min(1).max(1000),
    lineIndex: z.number().int().nonnegative().nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type QuoteShareQuestion = z.infer<typeof QuoteShareQuestion>;

export const QuoteShareStats = z
  .object({
    shareId: EntityId,
    quoteId: EntityId,
    version: z.number().int().positive(),
    /** 明文 token 只在创建时返回一次，事后无法还原，因此这里通常为 null。 */
    url: z.string().url().nullable(),
    createdAt: Timestamp,
    expiresAt: Timestamp,
    revokedAt: Timestamp.nullable(),
    requirePhoneTail: z.boolean(),
    allowPdf: z.boolean(),
    viewCount: z.number().int().nonnegative(),
    uniqueVisitors: z.number().int().nonnegative(),
    pdfDownloadCount: z.number().int().nonnegative(),
    questionCount: z.number().int().nonnegative(),
    acceptedAt: Timestamp.nullable(),
    lastViewedAt: Timestamp.nullable(),
    lastActivityAt: Timestamp.nullable(),
    questions: z.array(QuoteShareQuestion),
  })
  .strict();
export type QuoteShareStats = z.infer<typeof QuoteShareStats>;

export const QuoteShareStatsList = z
  .object({
    quoteId: EntityId,
    shares: z.array(QuoteShareStats),
  })
  .strict();
export type QuoteShareStatsList = z.infer<typeof QuoteShareStatsList>;
