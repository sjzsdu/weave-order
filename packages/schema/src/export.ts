import { z } from "zod";
import { Currency, Customer, EntityId, Money, QuoteStatus, Timestamp, Unit } from "./domain";
import { QuoteLineItem } from "./tools/t004-generate-quote-draft";

/**
 * 报价出口（阶段一）：可发给客户的报价单文件 + 「发送」这件事的一等实体。
 *
 * 语义决策（对应 `docs/usability-roadmap.md` 阶段一 · 报价要有出口）：
 * - `SENT` 只表示「人已经确认并导出」，不表示客户收到了；
 * - 「有没有发出去」由 `QuoteSendRecord` 决定：一条发送记录 = 一次导出并把文件
 *   交给了外部（业务员自己转发），记录谁、何时、什么渠道、发给谁、哪一版内容快照；
 * - 阶段一没有渠道 API，因此没有回执；`receiptStatus` / `receiptAt` / `externalRef`
 *   是为将来对接邮件/企微后的“渠道回执”预留的字段，当前一律为空。
 */

/** 发送渠道。阶段一只有「人工导出后自己转发」这一种真实渠道。 */
export const QuoteSendChannel = z.enum(["MANUAL_EXPORT"]);
export type QuoteSendChannel = z.infer<typeof QuoteSendChannel>;

/** 导出文件格式。阶段一只有 PDF；图片导出若要做，在这里加值并同步物理枚举。 */
export const QuoteSendFormat = z.enum(["PDF"]);
export type QuoteSendFormat = z.infer<typeof QuoteSendFormat>;

/** 渠道回执状态（预留）：null 表示该渠道不产生回执。 */
export const QuoteReceiptStatus = z.enum(["PENDING", "DELIVERED", "FAILED"]);
export type QuoteReceiptStatus = z.infer<typeof QuoteReceiptStatus>;

/**
 * 已确认报价的完整明细（只读）。
 *
 * 与 `QuoteDraft` 的区别：状态是完整的 `QuoteStatus`，不再限定 DRAFT。
 * 报价一经确认，明细仍然必须读得出来（`getDraft` 的 DRAFT 约束不放宽）。
 */
export const QuoteDetail = z.object({
  id: EntityId,
  customerId: EntityId,
  customer: Customer,
  status: QuoteStatus,
  currency: Currency,
  items: z.array(QuoteLineItem).min(1),
  subtotal: Money,
  total: Money,
  validityDays: z.number().int().positive(),
  expiresAt: Timestamp,
  createdAt: Timestamp,
  confirmedBy: z.string().max(128).nullable(),
  confirmedAt: Timestamp.nullable(),
  remarks: z.string().max(2000).nullable(),
});
export type QuoteDetail = z.infer<typeof QuoteDetail>;

/** 报价单抬头：卖家自己的公司信息（部署方配置，不是账本数据）。 */
export const QuoteCompanyHeader = z.object({
  name: z.string().min(1).max(255),
  address: z.string().max(255).nullable(),
  phone: z.string().max(64).nullable(),
  email: z.string().max(255).nullable(),
});
export type QuoteCompanyHeader = z.infer<typeof QuoteCompanyHeader>;

/** 快照里的一行：金额是整数分，展示格式由渲染层决定。 */
export const QuoteDocumentLine = z.object({
  position: z.number().int().nonnegative(),
  description: z.string().min(1).max(255),
  quantity: z.number().positive(),
  unit: Unit,
  unitPriceCents: z.number().int().nonnegative(),
  lineTotalCents: z.number().int().nonnegative(),
});
export type QuoteDocumentLine = z.infer<typeof QuoteDocumentLine>;

/**
 * 发给客户的那一版内容快照（写入发送记录，不可变）。
 *
 * 快照是「客户实际看到的东西」的完整来源：报价单 PDF 完全由它渲染，
 * 因此 `snapshotHash` 可以对上「这条发送记录对应哪一版内容」。
 */
export const QuoteDocumentSnapshot = z.object({
  company: QuoteCompanyHeader,
  customer: z.object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    contactName: z.string().max(255).nullable(),
    contactPhone: z.string().max(64).nullable(),
    contactEmail: z.string().max(255).nullable(),
  }),
  quote: z.object({
    id: EntityId,
    currency: Currency,
    subtotalCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(),
    validityDays: z.number().int().positive(),
    expiresAt: Timestamp,
    createdAt: Timestamp,
    confirmedAt: Timestamp.nullable(),
    confirmedBy: z.string().max(128).nullable(),
    remarks: z.string().max(2000).nullable(),
  }),
  lines: z.array(QuoteDocumentLine).min(1),
  /** 报价条款（价格口径、付款、交货等），来自部署方配置。 */
  terms: z.array(z.string().max(500)),
  generatedAt: Timestamp,
});
export type QuoteDocumentSnapshot = z.infer<typeof QuoteDocumentSnapshot>;

/**
 * 导出 / 记录发送的入参。
 * `recipient` 是「发给谁」（客户联系人 / 微信 / 邮箱），人工填写；
 * 不填也允许导出，但界面会提示没填接收方的记录无法追责到具体人。
 */
export const ExportQuoteInput = z
  .object({
    recipient: z.string().max(255).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();
export type ExportQuoteInput = z.infer<typeof ExportQuoteInput>;

/**
 * 内核记录发送的入参 = 人填写部分 + 服务端生成的内容快照。
 * 快照由导出层按内核读出的报价明细生成，调用方无法凭空指定「发了哪一版」。
 */
export const RecordQuoteSendInput = z
  .object({
    recipient: z.string().max(255).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    snapshot: QuoteDocumentSnapshot,
  })
  .strict();
export type RecordQuoteSendInput = z.infer<typeof RecordQuoteSendInput>;

/** 一条发送记录（导出即发送）。 */
export const QuoteSendRecord = z.object({
  id: EntityId,
  quoteId: EntityId,
  channel: QuoteSendChannel,
  format: QuoteSendFormat,
  actorType: z.enum(["AGENT", "HUMAN", "SYSTEM"]),
  actorId: z.string().min(1).max(128),
  recipient: z.string().max(255).nullable(),
  note: z.string().max(500).nullable(),
  /** 内容快照的 sha256（十六进制），用于回答「发的是哪一版」。 */
  snapshotHash: z.string().length(64),
  snapshot: QuoteDocumentSnapshot,
  /** 预留：渠道回执。人工导出渠道永远为 null。 */
  receiptStatus: QuoteReceiptStatus.nullable(),
  receiptAt: Timestamp.nullable(),
  externalRef: z.string().max(128).nullable(),
  createdAt: Timestamp,
});
export type QuoteSendRecord = z.infer<typeof QuoteSendRecord>;

/** 某份报价的发送记录（最新在前）。 */
export const QuoteSendList = z.object({ sends: z.array(QuoteSendRecord) }).strict();
export type QuoteSendList = z.infer<typeof QuoteSendList>;
