import {
  customers,
  quoteItems,
  quoteShareEvents,
  quoteShares,
  quotes,
  tenants,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  CreatedQuoteShare,
  CustomerAcceptQuoteInput,
  CustomerAcceptQuoteResult,
  CustomerAskQuestionInput,
  CustomerAskQuestionResult,
  CustomerQuotePage,
  CustomerQuoteView,
  CreateQuoteShareInput,
  QuoteShareStats,
  QuoteShareStatsList,
  QuoteShare,
} from "@weave-order/schema";
import type {
  CustomerQuotePage as CustomerPage,
  JsonValue,
  QuoteLinkErrorCode,
  QuoteShare as QuoteShareRecord,
} from "@weave-order/schema";
import { and, desc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import { milliToQuantity } from "./money";
import { currencyOf, toIso } from "./mappers";
import { createShareToken, hashAnonymous, hashToken, tokenHashMatches } from "./share-token";

type ShareRow = typeof quoteShares.$inferSelect;
type EventRow = typeof quoteShareEvents.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_QUOTE_STATUS = "SENT";

/** 客户侧可读的链接错误。控制器据此映射 400/410，不暴露内部原因。 */
export class QuoteLinkError extends Error {
  constructor(
    readonly code: QuoteLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QuoteLinkError";
  }
}

export interface ShareVisitor {
  /** 原始 IP；只落加盐哈希，不存明文。 */
  ip?: string;
  userAgent?: string;
}

export interface ShareServiceOptions {
  secret: string;
  publicAppUrl: string;
}

function quoteNumber(row: { id: string; createdAt: Date }): string {
  const date = row.createdAt.toISOString().slice(0, 10).replaceAll("-", "");
  return `Q-${date}-${row.id.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
}

function jsonObject(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * 报价分享内核服务。
 *
 * 铁律：
 * - 只存 `token_hash`，明文 token 只在 create 的返回值里出现一次；
 * - 客户视图只读客户可见字段（`CustomerQuoteView`），成本/毛利/内部备注一律不查；
 * - 「接受」只写一条 ACCEPTED 事件，绝不改报价账本 —— 接受 ≠ 合同。
 */
export class ShareService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly options: ShareServiceOptions,
  ) {}

  private urlFor(token: string): string {
    return `${this.options.publicAppUrl.replace(/\/+$/, "")}/s/${token}`;
  }

  private async getQuoteRow(quoteId: string) {
    const rows = await this.db
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, quoteId), eq(quotes.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
        resourceType: "quote",
        resourceId: quoteId,
      });
    }
    return row;
  }

  /** 只有已批准（SENT）的报价能生成链接；草稿绝不外发。 */
  async createForQuote(
    quoteId: string,
    input: unknown,
    ctx: KernelContext,
  ): Promise<CreatedQuoteShare> {
    const body = typeof input === "object" && input !== null ? input : {};
    // 路径参数是权威 quoteId；body 里试图夹带别的 quoteId 会被这里覆盖。
    const parsed = CreateQuoteShareInput.parse({ ...body, quoteId });
    const quote = await this.getQuoteRow(quoteId);
    if (quote.status !== ACTIVE_QUOTE_STATUS) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `只有已批准的报价才能分享，当前状态：${quote.status}`,
        { reason: "QUOTE_NOT_APPROVED" },
      );
    }
    const now = new Date();
    if (quote.expiresAt.getTime() <= now.getTime()) {
      throw new KernelError("KERNEL_REJECTED", "报价已过有效期，不能生成分享链接", {
        reason: "QUOTE_EXPIRED",
      });
    }

    // 有效期严格 = 报价有效期（§7.6 规则 3）。
    // 契约里的 expiresInDays 仅为兼容旧客户端保留，不参与计算，避免移动端默认 14 天截断报价有效期。
    const expiresAt = quote.expiresAt;
    const shareId = globalThis.crypto.randomUUID();
    const { token, tokenHash } = createShareToken(
      { t: this.tenantId, s: shareId },
      this.options.secret,
    );
    const version = (quote as typeof quote & { version?: number }).version ?? 1;

    const row = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(quoteShares)
        .values({
          id: shareId,
          tenantId: this.tenantId,
          quoteId,
          version,
          tokenHash,
          expiresAt,
          requirePhoneTail: parsed.requirePhoneTail,
          allowPdf: parsed.allowPdf,
          createdBy: ctx.actor.id,
        })
        .returning();
      const share = inserted[0];
      if (!share) {
        throw new KernelError("KERNEL_REJECTED", "分享链接写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "QUOTE_SHARE_CREATED",
          entityType: "quote_share",
          entityId: share.id,
          before: null,
          after: {
            quoteId,
            version,
            expiresAt: expiresAt.toISOString(),
            requirePhoneTail: share.requirePhoneTail,
            allowPdf: share.allowPdf,
          },
        },
        this.tenantId,
      );
      return share;
    });

    return CreatedQuoteShare.parse({
      share: this.mapShare(row),
      token,
      url: this.urlFor(token),
    });
  }

  /**
   * 兼容 T0 冻结的移动端契约：`POST /api/quote-shares`（quoteId 在 body）。
   * 与 `createForQuote` 完全同一条内核路径，只是入参形态不同。
   */
  async createFromInput(input: unknown, ctx: KernelContext): Promise<CreatedQuoteShare> {
    const parsed = CreateQuoteShareInput.parse(input);
    return this.createForQuote(parsed.quoteId, input, ctx);
  }

  /** 业务员的分享面板：每条链接看到多少次、是否接受、客户问了什么。 */
  async listForQuote(quoteId: string): Promise<QuoteShareStatsList> {
    await this.getQuoteRow(quoteId);
    const shareRows = await this.db
      .select()
      .from(quoteShares)
      .where(and(eq(quoteShares.quoteId, quoteId), eq(quoteShares.tenantId, this.tenantId)))
      .orderBy(desc(quoteShares.createdAt));
    const stats = await Promise.all(shareRows.map((row) => this.statsForShare(row)));
    return QuoteShareStatsList.parse({ quoteId, shares: stats });
  }

  /**
   * 兼容 T0 冻结的移动端契约：`GET /api/quote-shares?quoteId=`。
   * 返回 `{ share, url, viewCount, lastViewedAt }`；明文 token 不可还原，`url` 固定为空串。
   */
  async listLegacy(quoteId?: string): Promise<{
    shares: Array<{
      share: QuoteShareRecord;
      url: string;
      viewCount: number;
      lastViewedAt: string | null;
    }>;
  }> {
    let rows: ShareRow[];
    if (quoteId) {
      await this.getQuoteRow(quoteId);
      rows = await this.db
        .select()
        .from(quoteShares)
        .where(and(eq(quoteShares.quoteId, quoteId), eq(quoteShares.tenantId, this.tenantId)))
        .orderBy(desc(quoteShares.createdAt));
    } else {
      rows = await this.db
        .select()
        .from(quoteShares)
        .where(eq(quoteShares.tenantId, this.tenantId))
        .orderBy(desc(quoteShares.createdAt));
    }
    const stats = await Promise.all(rows.map((row) => this.statsForShare(row)));
    return {
      shares: rows.map((row, index) => ({
        share: this.mapShare(row),
        url: "",
        viewCount: stats[index]?.viewCount ?? 0,
        lastViewedAt: stats[index]?.lastViewedAt ?? null,
      })),
    };
  }

  async revoke(shareId: string, ctx: KernelContext): Promise<QuoteShareStats> {
    const rows = await this.db
      .select()
      .from(quoteShares)
      .where(and(eq(quoteShares.id, shareId), eq(quoteShares.tenantId, this.tenantId)))
      .limit(1);
    const share = rows[0];
    if (!share) {
      throw new KernelError("RESOURCE_NOT_FOUND", `分享链接不存在：${shareId}`, {
        resourceType: "quote_share",
        resourceId: shareId,
      });
    }
    if (share.revokedAt) return this.statsForShare(share);

    const revokedAt = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(quoteShares)
        .set({ revokedAt })
        .where(and(eq(quoteShares.id, shareId), eq(quoteShares.tenantId, this.tenantId)))
        .returning();
      const row = result[0];
      if (!row) {
        throw new KernelError("RESOURCE_NOT_FOUND", `分享链接不存在：${shareId}`, {
          resourceType: "quote_share",
          resourceId: shareId,
        });
      }
      await tx.insert(quoteShareEvents).values({
        tenantId: this.tenantId,
        shareId,
        event: "REVOKED",
        meta: { revokedBy: ctx.actor.id },
      });
      await appendAudit(
        tx,
        ctx,
        {
          action: "QUOTE_SHARE_REVOKED",
          entityType: "quote_share",
          entityId: shareId,
          before: { revokedAt: null },
          after: { revokedAt: revokedAt.toISOString() },
        },
        this.tenantId,
      );
      return row;
    });
    return this.statsForShare(updated);
  }

  // ---------------------------------------------------------------------------
  // 公开路由（无登录）：调用方已根据签名 token 打开租户会话。
  // ---------------------------------------------------------------------------

  /** 读客户视图并记一次 VIEWED。不返回任何内部字段。 */
  async viewForCustomer(
    shareId: string,
    token: string,
    visitor: ShareVisitor,
    options: { track?: boolean } = {},
  ): Promise<CustomerPage> {
    const share = await this.requireActiveShare(shareId, token);
    const page = await this.buildCustomerPage(share, token);
    // 打印页只需要读取同一份客户视图，不应重复计一次浏览。
    if (options.track !== false) {
      await this.recordEvent(shareId, "VIEWED", null, visitor);
    }
    return page;
  }

  async acceptForCustomer(
    shareId: string,
    token: string,
    input: unknown,
    visitor: ShareVisitor,
  ): Promise<CustomerAcceptQuoteResult> {
    const parsed = CustomerAcceptQuoteInput.parse(input);
    const share = await this.requireActiveShare(shareId, token);
    const quote = await this.getQuoteRow(share.quoteId);
    if (quote.status !== ACTIVE_QUOTE_STATUS) {
      throw new QuoteLinkError("INVALID_LINK", "该报价已失效，请联系您的业务员");
    }

    if (share.requirePhoneTail) {
      const customerRows = await this.db
        .select({ phone: customers.contactPhone })
        .from(customers)
        .where(and(eq(customers.id, quote.customerId), eq(customers.tenantId, this.tenantId)))
        .limit(1);
      const phone = customerRows[0]?.phone ?? null;
      const tail = phone ? phone.replace(/\D/g, "").slice(-4) : "";
      if (!parsed.phoneTail) {
        throw new QuoteLinkError("PHONE_TAIL_REQUIRED", "请填写联系人手机尾号后 4 位");
      }
      if (!tail || tail !== parsed.phoneTail) {
        throw new QuoteLinkError("PHONE_TAIL_MISMATCH", "手机尾号不匹配，请核对后重试");
      }
    }

    const existing = await this.latestEvent(shareId, "ACCEPTED");
    if (existing) {
      return CustomerAcceptQuoteResult.parse({
        acceptedAt: toIso(existing.createdAt),
        alreadyAccepted: true,
        nextStep: "接受仅为成交意向，业务员确认后会转订单草稿",
      });
    }

    const event = await this.recordEvent(
      shareId,
      "ACCEPTED",
      {
        phoneTailVerified: share.requirePhoneTail,
      },
      visitor,
    );
    return CustomerAcceptQuoteResult.parse({
      acceptedAt: toIso(event.createdAt),
      alreadyAccepted: false,
      nextStep: "接受仅为成交意向，业务员确认后会转订单草稿",
    });
  }

  async askForCustomer(
    shareId: string,
    token: string,
    input: unknown,
    visitor: ShareVisitor,
  ): Promise<CustomerAskQuestionResult> {
    const parsed = CustomerAskQuestionInput.parse(input);
    const share = await this.requireActiveShare(shareId, token);
    await this.buildCustomerPage(share, token); // 校验报价仍在有效状态
    const event = await this.recordEvent(
      shareId,
      "QUESTION_ASKED",
      {
        message: parsed.message,
        lineIndex: parsed.lineIndex ?? null,
      },
      visitor,
    );
    return CustomerAskQuestionResult.parse({
      eventId: event.id,
      createdAt: toIso(event.createdAt),
    });
  }

  async recordPdfDownload(shareId: string, token: string, visitor: ShareVisitor): Promise<void> {
    const share = await this.requireActiveShare(shareId, token);
    if (!share.allowPdf) {
      throw new QuoteLinkError("PDF_DISABLED", "该报价未开放 PDF 下载");
    }
    await this.buildCustomerPage(share, token);
    await this.recordEvent(shareId, "PDF_DOWNLOADED", null, visitor);
  }

  // ---------------------------------------------------------------------------

  private async requireActiveShare(shareId: string, token: string): Promise<ShareRow> {
    const rows = await this.db
      .select()
      .from(quoteShares)
      .where(and(eq(quoteShares.id, shareId), eq(quoteShares.tenantId, this.tenantId)))
      .limit(1);
    const share = rows[0];
    if (!share || !tokenHashMatches(hashToken(token), share.tokenHash)) {
      throw new QuoteLinkError("INVALID_LINK", "链接无效，请联系您的业务员重新获取");
    }
    if (share.revokedAt) {
      throw new QuoteLinkError("REVOKED", "该报价链接已撤回，请联系您的业务员");
    }
    if (share.expiresAt.getTime() <= Date.now()) {
      throw new QuoteLinkError("EXPIRED", "该报价链接已过期，请联系您的业务员");
    }
    return share;
  }

  private mapShare(row: ShareRow): QuoteShareRecord {
    return QuoteShare.parse({
      id: row.id,
      tenantId: row.tenantId,
      quoteId: row.quoteId,
      version: row.version,
      tokenHash: row.tokenHash,
      expiresAt: toIso(row.expiresAt),
      requirePhoneTail: row.requirePhoneTail,
      allowPdf: row.allowPdf,
      revokedAt: row.revokedAt ? toIso(row.revokedAt) : null,
      createdBy: row.createdBy,
      createdAt: toIso(row.createdAt),
    });
  }

  private async buildCustomerPage(share: ShareRow, token: string): Promise<CustomerPage> {
    const quote = await this.getQuoteRow(share.quoteId);
    if (quote.status !== ACTIVE_QUOTE_STATUS) {
      throw new QuoteLinkError("INVALID_LINK", "该报价已失效，请联系您的业务员");
    }
    // 顺序查询：公开路由跑在一条独占连接上，避免同一 client 并发 query。
    const customerRows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, quote.customerId), eq(customers.tenantId, this.tenantId)))
      .limit(1);
    const tenantRows = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, this.tenantId))
      .limit(1);
    const itemRows = await this.db
      .select()
      .from(quoteItems)
      .where(and(eq(quoteItems.quoteId, quote.id), eq(quoteItems.tenantId, this.tenantId)))
      .orderBy(quoteItems.position);
    const customer = customerRows[0];
    const tenant = tenantRows[0];
    if (!customer || !tenant) {
      throw new QuoteLinkError("INVALID_LINK", "链接无效，请联系您的业务员");
    }

    const accepted = await this.latestEvent(share.id, "ACCEPTED");
    const remainingDays = Math.max(0, Math.ceil((share.expiresAt.getTime() - Date.now()) / DAY_MS));
    const settings = jsonObject(tenant.settings);
    const terms = asString(settings?.quoteTerms);

    const view = CustomerQuoteView.parse({
      shareToken: token,
      quoteNumber: quoteNumber(quote),
      tenantName: tenant.name,
      customerName: customer.name,
      currency: currencyOf(quote.currency),
      lines: itemRows.map((item) => ({
        description: item.description,
        quantity: milliToQuantity(item.quantityMilli),
        unit: item.unit,
        unitPriceAmount: item.unitPriceAmount,
        lineTotalAmount: item.lineTotalAmount,
      })),
      subtotalAmount: quote.subtotalAmount,
      totalAmount: quote.totalAmount,
      expiresAt: toIso(share.expiresAt),
      allowPdf: share.allowPdf,
    });

    return CustomerQuotePage.parse({
      view,
      acceptedAt: accepted ? toIso(accepted.createdAt) : null,
      remainingDays,
      requirePhoneTail: share.requirePhoneTail,
      salesName: null,
      terms,
    });
  }

  private async recordEvent(
    shareId: string,
    event: EventRow["event"],
    meta: JsonValue | null,
    visitor: ShareVisitor,
  ): Promise<EventRow> {
    const ipHash = visitor.ip ? hashAnonymous(visitor.ip, this.options.secret) : null;
    const uaHash = visitor.userAgent ? hashAnonymous(visitor.userAgent, this.options.secret) : null;
    const rows = await this.db
      .insert(quoteShareEvents)
      .values({
        tenantId: this.tenantId,
        shareId,
        event,
        meta,
        ipHash,
        uaHash,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new KernelError("KERNEL_REJECTED", "分享事件写入未返回记录", {
        reason: "INSERT_RETURNED_NO_ROW",
      });
    }
    return row;
  }

  private async latestEvent(shareId: string, event: EventRow["event"]): Promise<EventRow | null> {
    const rows = await this.db
      .select()
      .from(quoteShareEvents)
      .where(
        and(
          eq(quoteShareEvents.shareId, shareId),
          eq(quoteShareEvents.tenantId, this.tenantId),
          eq(quoteShareEvents.event, event),
        ),
      )
      .orderBy(desc(quoteShareEvents.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private async statsForShare(share: ShareRow): Promise<QuoteShareStats> {
    const events = await this.db
      .select()
      .from(quoteShareEvents)
      .where(
        and(eq(quoteShareEvents.shareId, share.id), eq(quoteShareEvents.tenantId, this.tenantId)),
      )
      .orderBy(desc(quoteShareEvents.createdAt));

    const views = events.filter((event) => event.event === "VIEWED");
    const visitors = new Set(views.map((event) => event.ipHash).filter((hash) => hash !== null));
    const accepted = events.find((event) => event.event === "ACCEPTED") ?? null;
    const questions = events
      .filter((event) => event.event === "QUESTION_ASKED")
      .map((event) => {
        const meta = jsonObject(event.meta);
        const message = asString(meta?.message);
        if (!message) return null;
        return {
          eventId: event.id,
          message,
          lineIndex: asNumber(meta?.lineIndex),
          createdAt: toIso(event.createdAt),
        };
      })
      .filter((question): question is NonNullable<typeof question> => question !== null)
      .slice(0, 20);

    return QuoteShareStats.parse({
      shareId: share.id,
      quoteId: share.quoteId,
      version: share.version,
      url: null,
      createdAt: toIso(share.createdAt),
      expiresAt: toIso(share.expiresAt),
      revokedAt: share.revokedAt ? toIso(share.revokedAt) : null,
      requirePhoneTail: share.requirePhoneTail,
      allowPdf: share.allowPdf,
      viewCount: views.length,
      uniqueVisitors: visitors.size,
      pdfDownloadCount: events.filter((event) => event.event === "PDF_DOWNLOADED").length,
      questionCount: events.filter((event) => event.event === "QUESTION_ASKED").length,
      acceptedAt: accepted ? toIso(accepted.createdAt) : null,
      lastViewedAt: views[0] ? toIso(views[0].createdAt) : null,
      lastActivityAt: events[0] ? toIso(events[0].createdAt) : null,
      questions,
    });
  }
}
