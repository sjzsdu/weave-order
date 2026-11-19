import {
  customerContacts,
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
  CustomerSalesContact,
  CreateQuoteShareInput,
  QuoteShareStats,
  QuoteShareStatsList,
  QuoteShare,
  pickDefaultContact,
} from "@weave-order/schema";
import type {
  CustomerQuotePage as CustomerPage,
  JsonValue,
  QuoteLinkErrorCode,
  QuoteShare as QuoteShareRecord,
} from "@weave-order/schema";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import { milliToQuantity } from "./money";
import { currencyOf, toIso } from "./mappers";
import {
  buildShareUrl,
  createShareToken,
  hashAnonymous,
  hashToken,
  tokenHashMatches,
} from "./share-token";

type ShareRow = typeof quoteShares.$inferSelect;
type EventRow = typeof quoteShareEvents.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_QUOTE_STATUS = "SENT";
/**
 * 同一 (链接, IP) 的 VIEWED 去重窗口。
 * 机器人刷页面时最多每窗口写一行，分享面板的「查看次数」语义变为「访问次数」，
 * 但防增长是硬要求：事件表不能让公网请求无限放大。
 */
const VIEW_DEDUP_WINDOW_SECONDS = 10 * 60;
const MAX_QUESTIONS_PER_SHARE = 20;

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

/** 只保留「可拨打的实名名片」，不把完整手机号写进客户页。 */
function maskPhone(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function safeQrUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * `max(timestamptz)` 经 raw `sql<>` 片段返回时是字符串（Drizzle 不会对自定义表达式套类型映射），
 * 而普通 select 返回 Date。两种都归一成 ISO，避免统计接口因为返回通道不同而崩。
 */
function isoFromAggregate(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * 销售名片来自租户配置 `tenants.settings.salesContact`：
 * `{ name, phone, wechatQrUrl }`。电话只输出脱敏版；未配置则整块不展示。
 */
function salesContactFromSettings(
  settings: Record<string, JsonValue> | null,
): CustomerSalesContact | null {
  const raw = settings?.salesContact;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const contact = raw as Record<string, JsonValue>;
  if (typeof contact.name !== "string" || contact.name.trim().length === 0) return null;
  return CustomerSalesContact.parse({
    name: contact.name.trim().slice(0, 255),
    phoneMasked: maskPhone(contact.phone),
    wechatQrUrl: safeQrUrl(contact.wechatQrUrl),
  });
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
    // 与生产门禁共用同一个拼装函数（见 share-token.ts），避免两处各写一套斜杠规则。
    return buildShareUrl(this.options.publicAppUrl, token);
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
    // 外发记录必须带 contact_id + 快照：显式指定 → 按场景挑（报价找采购）→ 主联系人。
    const contactRows = await this.db
      .select()
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, this.tenantId),
          eq(customerContacts.customerId, quote.customerId),
          isNull(customerContacts.archivedAt),
        ),
      )
      .orderBy(desc(customerContacts.isPrimary), desc(customerContacts.createdAt));
    const chosenContact = parsed.contactId
      ? (contactRows.find((contact) => contact.id === parsed.contactId) ?? null)
      : pickDefaultContact(contactRows, "quote");
    if (parsed.contactId && !chosenContact) {
      throw new KernelError("KERNEL_REJECTED", "收件联系人不存在或已归档", {
        reason: "CONTACT_NOT_FOUND",
      });
    }
    const contactSnapshot = chosenContact
      ? { name: chosenContact.name, email: chosenContact.email }
      : null;

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
          contactId: chosenContact?.id ?? null,
          contactSnapshot,
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
            contactId: share.contactId,
            contactName: share.contactSnapshot?.name ?? null,
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
    const stats = await this.statsForShares(shareRows);
    return QuoteShareStatsList.parse({
      quoteId,
      shares: shareRows.map((row) => stats.get(row.id) as QuoteShareStats),
    });
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
    const stats = await this.statsForShares(rows);
    return {
      shares: rows.map((row) => ({
        share: this.mapShare(row),
        url: "",
        viewCount: stats.get(row.id)?.viewCount ?? 0,
        lastViewedAt: stats.get(row.id)?.lastViewedAt ?? null,
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
    const page = await this.buildCustomerPage(share);
    // 打印页只需要读取同一份客户视图，不应重复计一次浏览。
    if (options.track !== false) {
      await this.recordViewEvent(shareId, visitor);
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
    await this.buildCustomerPage(share); // 校验报价仍在有效状态
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
    await this.buildCustomerPage(share);
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
      contactId: row.contactId,
      contactSnapshot: row.contactSnapshot ?? null,
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

  private async buildCustomerPage(share: ShareRow): Promise<CustomerPage> {
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
      salesContact: salesContactFromSettings(settings),
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

  /**
   * VIEWED 去重：同一 `(shareId, ipHash)` 在窗口内只落一行。
   *
   * 用一条 `INSERT ... SELECT ... WHERE NOT EXISTS` 完成判定与写入，
   * 避免「先查后插」在并发刷页时双双通过。没有 IP 的请求（如内网探针）
   * 仍按 `ipHash IS NULL` 归为同一访客，同样受窗口约束。
   */
  private async recordViewEvent(shareId: string, visitor: ShareVisitor): Promise<void> {
    const ipHash = visitor.ip ? hashAnonymous(visitor.ip, this.options.secret) : null;
    const uaHash = visitor.userAgent ? hashAnonymous(visitor.userAgent, this.options.secret) : null;
    await this.db.execute(sql`
      INSERT INTO quote_share_events (tenant_id, share_id, event, ip_hash, ua_hash)
      SELECT ${this.tenantId}::uuid, ${shareId}::uuid, 'VIEWED', ${ipHash}::varchar, ${uaHash}::varchar
      WHERE NOT EXISTS (
        SELECT 1 FROM quote_share_events e
        WHERE e.tenant_id = ${this.tenantId}::uuid
          AND e.share_id = ${shareId}::uuid
          AND e.event = 'VIEWED'
          AND e.ip_hash IS NOT DISTINCT FROM ${ipHash}::varchar
          AND e.created_at > now() - make_interval(secs => ${VIEW_DEDUP_WINDOW_SECONDS})
      )
    `);
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
    const stats = await this.statsForShares([share]);
    const result = stats.get(share.id);
    if (!result) {
      throw new KernelError("KERNEL_REJECTED", "分享统计聚合未返回记录", {
        reason: "STATS_AGGREGATION_EMPTY",
        resourceType: "quote_share",
        resourceId: share.id,
      });
    }
    return result;
  }

  /**
   * 分享面板统计：整批链接一次聚合，事件表只做 `count(*) filter (...)`。
   *
   * 改写前会把每条链接的全部事件读进内存再 filter，10 万条事件 = 10 万行 × 链接数；
   * 现在无论事件多少，每个链接固定返回一行聚合结果，问题列表用窗口函数截断到 20 条。
   */
  private async statsForShares(shares: ShareRow[]): Promise<Map<string, QuoteShareStats>> {
    const result = new Map<string, QuoteShareStats>();
    if (shares.length === 0) return result;

    const shareIds = shares.map((share) => share.id);
    const aggregated = await this.db
      .select({
        shareId: quoteShareEvents.shareId,
        viewCount: sql<number>`(count(*) filter (where ${quoteShareEvents.event} = 'VIEWED'))::int`,
        pdfDownloadCount: sql<number>`(count(*) filter (
          where ${quoteShareEvents.event} = 'PDF_DOWNLOADED'
        ))::int`,
        questionCount: sql<number>`(count(*) filter (
          where ${quoteShareEvents.event} = 'QUESTION_ASKED'
        ))::int`,
        acceptedAt: sql<Date | string | null>`max(${quoteShareEvents.createdAt}) filter (
          where ${quoteShareEvents.event} = 'ACCEPTED'
        )`,
        lastViewedAt: sql<Date | string | null>`max(${quoteShareEvents.createdAt}) filter (
          where ${quoteShareEvents.event} = 'VIEWED'
        )`,
        lastActivityAt: sql<Date | string | null>`max(${quoteShareEvents.createdAt})`,
      })
      .from(quoteShareEvents)
      .where(
        and(
          eq(quoteShareEvents.tenantId, this.tenantId),
          inArray(quoteShareEvents.shareId, shareIds),
        ),
      )
      .groupBy(quoteShareEvents.shareId);

    // 独立访客单独查：`count(distinct ip_hash)` 会让整批行的排序键变成 ip_hash，
    // 与其余计数混在一条语句里会把 10 万行全部外部排序；拆开后走
    // `(tenant_id, share_id, event, ip_hash)` 索引，内存和耗时都可控。
    const uniqueRows = await this.db
      .select({
        shareId: quoteShareEvents.shareId,
        uniqueVisitors: sql<number>`(count(distinct ${quoteShareEvents.ipHash}))::int`,
      })
      .from(quoteShareEvents)
      .where(
        and(
          eq(quoteShareEvents.tenantId, this.tenantId),
          inArray(quoteShareEvents.shareId, shareIds),
          eq(quoteShareEvents.event, "VIEWED"),
          isNotNull(quoteShareEvents.ipHash),
        ),
      )
      .groupBy(quoteShareEvents.shareId);

    const ranked = this.db
      .select({
        id: quoteShareEvents.id,
        shareId: quoteShareEvents.shareId,
        meta: quoteShareEvents.meta,
        createdAt: quoteShareEvents.createdAt,
        rank: sql<number>`row_number() over (
          partition by ${quoteShareEvents.shareId}
          order by ${quoteShareEvents.createdAt} desc, ${quoteShareEvents.id} desc
        )`.as("rank"),
      })
      .from(quoteShareEvents)
      .where(
        and(
          eq(quoteShareEvents.tenantId, this.tenantId),
          inArray(quoteShareEvents.shareId, shareIds),
          eq(quoteShareEvents.event, "QUESTION_ASKED"),
        ),
      )
      .as("ranked_questions");

    const questionRows = await this.db
      .select()
      .from(ranked)
      .where(sql`${ranked.rank} <= ${MAX_QUESTIONS_PER_SHARE}`)
      .orderBy(desc(ranked.createdAt));

    const questionsByShare = new Map<string, QuoteShareStats["questions"]>();
    for (const row of questionRows) {
      const meta = jsonObject(row.meta);
      const message = asString(meta?.message);
      if (!message) continue;
      const list = questionsByShare.get(row.shareId) ?? [];
      list.push({
        eventId: row.id,
        message,
        lineIndex: asNumber(meta?.lineIndex),
        createdAt: toIso(row.createdAt),
      });
      questionsByShare.set(row.shareId, list);
    }

    const aggregateByShare = new Map(aggregated.map((row) => [row.shareId, row]));
    const uniqueByShare = new Map(uniqueRows.map((row) => [row.shareId, row.uniqueVisitors]));
    for (const share of shares) {
      const aggregate = aggregateByShare.get(share.id);
      result.set(
        share.id,
        QuoteShareStats.parse({
          shareId: share.id,
          quoteId: share.quoteId,
          version: share.version,
          url: null,
          createdAt: toIso(share.createdAt),
          expiresAt: toIso(share.expiresAt),
          revokedAt: share.revokedAt ? toIso(share.revokedAt) : null,
          requirePhoneTail: share.requirePhoneTail,
          allowPdf: share.allowPdf,
          viewCount: aggregate?.viewCount ?? 0,
          uniqueVisitors: uniqueByShare.get(share.id) ?? 0,
          pdfDownloadCount: aggregate?.pdfDownloadCount ?? 0,
          questionCount: aggregate?.questionCount ?? 0,
          acceptedAt: isoFromAggregate(aggregate?.acceptedAt ?? null),
          lastViewedAt: isoFromAggregate(aggregate?.lastViewedAt ?? null),
          lastActivityAt: isoFromAggregate(aggregate?.lastActivityAt ?? null),
          questions: questionsByShare.get(share.id) ?? [],
        }),
      );
    }
    return result;
  }
}
