import { createHash } from "node:crypto";
import { quoteItems, quoteSends, quotes } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  ApprovalItem,
  RecordQuoteSendInput,
  T004GenerateQuoteDraftInput,
} from "@weave-order/schema";
import type {
  JsonValue,
  QuoteConfirmation,
  QuoteDetail,
  QuoteDocumentSnapshot,
  QuoteDraft,
  QuoteLineItem,
  QuoteSendRecord,
} from "@weave-order/schema";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import type { CustomerService } from "./customers.service";
import { KernelError } from "./errors";
import { formatMoney, milliToQuantity, multiplyCents, quantityToMilli } from "./money";
import { currencyOf, toIso } from "./mappers";
import type { SampleService } from "./samples.service";

type QuoteRow = typeof quotes.$inferSelect;
type QuoteItemRow = typeof quoteItems.$inferSelect;
type QuoteSendRow = typeof quoteSends.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 能导出（= 记录一次发送）的报价状态：必须先被人确认过。 */
const EXPORTABLE_STATUSES = new Set(["SENT", "ACCEPTED"]);

/**
 * 快照规范化 JSON：对象键排序后序列化。
 * `snapshot` 落在 PostgreSQL jsonb 里，读回来的键顺序不保证，所以 hash 必须
 * 建立在「键顺序无关」的规范形式上，否则同一版内容会算出不同的 hash。
 */
export function canonicalSnapshotJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalSnapshotJson(item)).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSnapshotJson(value[key] ?? null)}`);
  return `{${entries.join(",")}}`;
}

/** 内容快照的 sha256（十六进制）：回答「这条发送记录发的是哪一版」。 */
export function hashQuoteSnapshot(snapshot: QuoteDocumentSnapshot): string {
  const canonical = canonicalSnapshotJson(snapshot);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function mapQuoteSend(row: QuoteSendRow): QuoteSendRecord {
  return {
    id: row.id,
    quoteId: row.quoteId,
    channel: row.channel,
    format: row.format as QuoteSendRecord["format"],
    actorType: row.actorType,
    actorId: row.actorId,
    recipient: row.recipient,
    note: row.note,
    snapshotHash: row.snapshotHash,
    snapshot: row.snapshot as unknown as QuoteDocumentSnapshot,
    receiptStatus: row.receiptStatus as QuoteSendRecord["receiptStatus"],
    receiptAt: row.receiptAt ? toIso(row.receiptAt) : null,
    externalRef: row.externalRef,
    createdAt: toIso(row.createdAt),
  };
}

function mapQuote(row: QuoteRow, items: QuoteLineItem[]): QuoteDraft {
  return {
    id: row.id,
    customerId: row.customerId,
    status: "DRAFT",
    currency: row.currency,
    items,
    subtotal: { amount: row.subtotalAmount, currency: row.currency },
    total: { amount: row.totalAmount, currency: row.currency },
    amountsComputedByKernel: true,
    validityDays: row.validityDays,
    expiresAt: toIso(row.expiresAt),
    createdAt: toIso(row.createdAt),
    remarks: row.remarks,
  };
}

/**
 * 报价内核服务。
 *
 * 金额是内核算出来的，不是智能体填的：
 * - 行金额 = 整数分单价 × 千分之一数量，一次显式 half-up 舍入；
 * - 单价低于样品成本底线、币种/单位不一致，一律 KERNEL_REJECTED；
 * - 草稿状态固定 DRAFT，人类 confirm 后才转 SENT。
 */
export class QuoteService {
  constructor(
    private readonly db: Db,
    private readonly customers: CustomerService,
    private readonly samples: SampleService,
  ) {}

  async generateDraft(input: unknown, ctx: KernelContext): Promise<QuoteDraft> {
    const parsed = T004GenerateQuoteDraftInput.parse(input);
    await this.customers.getById(parsed.customerId);

    const sampleIds = parsed.items.map((item) => item.fabricSampleId);
    const samplesById = await this.samples.getManyByIds(sampleIds);

    const lineInputs = parsed.items.map((item, index) => {
      const sample = samplesById.get(item.fabricSampleId);
      if (!sample) {
        throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${item.fabricSampleId}`, {
          resourceType: "sample",
          resourceId: item.fabricSampleId,
        });
      }
      if (item.unitPrice.currency !== parsed.currency) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `第 ${index + 1} 行单价币种 ${item.unitPrice.currency} 与报价币种 ${parsed.currency} 不一致`,
          { reason: "CURRENCY_MISMATCH" },
        );
      }
      if (item.quantity.unit !== sample.unit) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `第 ${index + 1} 行数量单位 ${item.quantity.unit} 与样品 ${sample.code} 的单位 ${sample.unit} 不一致`,
          { reason: "UNIT_MISMATCH" },
        );
      }
      if (sample.costFloor) {
        if (sample.costFloor.currency !== parsed.currency) {
          throw new KernelError(
            "KERNEL_REJECTED",
            `样品 ${sample.code} 的成本底线币种与报价币种不一致，内核无法判定价格是否合规`,
            { reason: "CURRENCY_MISMATCH" },
          );
        }
        if (item.unitPrice.amount < sample.costFloor.amount) {
          throw new KernelError(
            "KERNEL_REJECTED",
            `第 ${index + 1} 行单价低于成本底线：${item.unitPrice.amount} < ${sample.costFloor.amount}（分）`,
            { reason: "PRICE_BELOW_COST_FLOOR" },
          );
        }
      }

      const quantityMilli = quantityToMilli(item.quantity.value);
      const lineTotalAmount = multiplyCents(item.unitPrice.amount, quantityMilli);
      return {
        sampleId: sample.id,
        position: index,
        description: sample.name,
        quantityMilli,
        unit: item.quantity.unit,
        unitPriceAmount: item.unitPrice.amount,
        lineTotalAmount,
      };
    });

    const subtotalAmount = lineInputs.reduce((sum, line) => sum + line.lineTotalAmount, 0);
    const totalAmount = subtotalAmount;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + parsed.validityDays * DAY_MS);

    return this.db.transaction(async (tx) => {
      const quoteRows = await tx
        .insert(quotes)
        .values({
          customerId: parsed.customerId,
          status: "DRAFT",
          currency: parsed.currency,
          subtotalAmount,
          totalAmount,
          validityDays: parsed.validityDays,
          expiresAt,
          remarks: parsed.remarks ?? null,
        })
        .returning();
      const quoteRow = quoteRows[0];
      if (!quoteRow) {
        throw new KernelError("KERNEL_REJECTED", "报价写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }

      const inserted = await tx
        .insert(quoteItems)
        .values(lineInputs.map((line) => ({ ...line, quoteId: quoteRow.id })))
        .returning();

      await appendAudit(tx, ctx, {
        action: "QUOTE_DRAFT_GENERATED",
        entityType: "quote",
        entityId: quoteRow.id,
        before: null,
        after: {
          customerId: quoteRow.customerId,
          status: quoteRow.status,
          totalAmount,
          currency: quoteRow.currency,
          lineCount: inserted.length,
        },
      });

      const items: QuoteLineItem[] = inserted
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((row: QuoteItemRow) => ({
          fabricSampleId: row.sampleId,
          description: row.description,
          quantity: {
            value: milliToQuantity(row.quantityMilli),
            unit: row.unit,
          },
          unitPrice: {
            amount: row.unitPriceAmount,
            currency: quoteRow.currency,
          },
          lineTotal: { amount: row.lineTotalAmount, currency: quoteRow.currency },
        }));

      return mapQuote(quoteRow, items);
    });
  }

  /**
   * 读出报价行 + 明细，不校验状态。
   * `getDraft`（只允许 DRAFT）与 `getDetail`（任何状态都可读）共用这一次读取。
   */
  private async readQuote(
    quoteId: string,
  ): Promise<{ row: QuoteRow; items: QuoteLineItem[] }> {
    const rows = await this.db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
        resourceType: "quote",
        resourceId: quoteId,
      });
    }
    const itemRows = await this.db
      .select()
      .from(quoteItems)
      .where(eq(quoteItems.quoteId, quoteId))
      .orderBy(asc(quoteItems.position));
    const items: QuoteLineItem[] = itemRows.map((item) => ({
      fabricSampleId: item.sampleId,
      description: item.description,
      quantity: { value: milliToQuantity(item.quantityMilli), unit: item.unit },
      unitPrice: { amount: item.unitPriceAmount, currency: row.currency },
      lineTotal: { amount: item.lineTotalAmount, currency: row.currency },
    }));
    return { row, items };
  }

  async getDraft(quoteId: string): Promise<QuoteDraft> {
    const { row, items } = await this.readQuote(quoteId);
    if (row.status !== "DRAFT") {
      throw new KernelError("KERNEL_REJECTED", `报价单不是草稿状态：${row.status}`, {
        reason: "INVALID_STATE_TRANSITION",
      });
    }
    return mapQuote(row, items);
  }

  /**
   * 已确认报价的完整明细（只读，不限制状态）。
   *
   * `getDraft` 的 DRAFT 约束保持不变：它服务的是「审批前的草稿」场景。
   * 报价一旦确认，业务上仍然需要读回明细（重发、对账、导出报价单），
   * 因此另开一个不做状态限制的读取方法，而不是放宽 getDraft。
   */
  async getDetail(quoteId: string): Promise<QuoteDetail> {
    const { row, items } = await this.readQuote(quoteId);
    const customer = await this.customers.getById(row.customerId);
    return {
      id: row.id,
      customerId: row.customerId,
      customer,
      status: row.status,
      currency: row.currency,
      items,
      subtotal: { amount: row.subtotalAmount, currency: row.currency },
      total: { amount: row.totalAmount, currency: row.currency },
      validityDays: row.validityDays,
      expiresAt: toIso(row.expiresAt),
      createdAt: toIso(row.createdAt),
      confirmedBy: row.confirmedBy ?? null,
      confirmedAt: row.confirmedAt ? toIso(row.confirmedAt) : null,
      remarks: row.remarks,
    };
  }

  /**
   * 记录一次「报价已导出并交给客户」= 一条发送记录。
   *
   * 只有被人确认过的报价才能记录发送（SENT / ACCEPTED）：草稿还没被批准，
   * 驳回或过期但未确认过的报价不构成一次真实发送。
   * 发送记录与审计同一事务写入：账本上不会出现「导出了但没有记录」。
   */
  async recordSend(
    quoteId: string,
    ctx: KernelContext,
    input: unknown,
  ): Promise<QuoteSendRecord> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "报价导出发送必须由人执行，智能体不能代替人对外发送",
      );
    }
    const parsed = RecordQuoteSendInput.parse(input);
    const rows = await this.db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    const quoteRow = rows[0];
    if (!quoteRow) {
      throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
        resourceType: "quote",
        resourceId: quoteId,
      });
    }
    if (!EXPORTABLE_STATUSES.has(quoteRow.status)) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `报价单尚未被确认，不能记录发送：${quoteRow.status}`,
        { reason: "QUOTE_NOT_CONFIRMED" },
      );
    }

    const snapshotHash = hashQuoteSnapshot(parsed.snapshot);
    const createdAt = new Date();
    const insertedRows = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(quoteSends)
        .values({
          quoteId,
          channel: "MANUAL_EXPORT",
          format: "PDF",
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          recipient: parsed.recipient ?? null,
          note: parsed.note ?? null,
          snapshot: parsed.snapshot,
          snapshotHash,
          createdAt,
        })
        .returning();
      const sendRow = inserted[0];
      if (!sendRow) {
        throw new KernelError("KERNEL_REJECTED", "发送记录写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }
      await appendAudit(tx, ctx, {
        action: "QUOTE_EXPORTED",
        entityType: "quote",
        entityId: quoteId,
        before: { status: quoteRow.status },
        after: {
          sendId: sendRow.id,
          channel: sendRow.channel,
          format: sendRow.format,
          recipient: sendRow.recipient,
          snapshotHash,
        },
      });
      return inserted;
    });

    const sendRow = insertedRows[0];
    if (!sendRow) {
      throw new KernelError("KERNEL_REJECTED", "发送记录写入未返回记录", {
        reason: "INSERT_RETURNED_NO_ROW",
      });
    }
    return mapQuoteSend(sendRow);
  }

  /** 某份报价的发送记录（最新在前）。空数组 = 从未发出去过。 */
  async listSends(quoteId: string): Promise<QuoteSendRecord[]> {
    const rows = await this.db
      .select()
      .from(quoteSends)
      .where(eq(quoteSends.quoteId, quoteId))
      .orderBy(desc(quoteSends.createdAt));
    return rows.map(mapQuoteSend);
  }

  /** 人类审批窗口确认报价草稿：DRAFT -> SENT。智能体无权确认。 */
  async confirmDraft(quoteId: string, ctx: KernelContext): Promise<QuoteConfirmation> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "报价确认必须由人类在审批窗口执行，智能体无权确认",
      );
    }
    const current = await this.getDraft(quoteId);
    const confirmedAt = new Date();
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(quotes)
        .set({
          status: "SENT",
          confirmedBy: ctx.actor.id,
          confirmedAt,
          updatedAt: confirmedAt,
        })
        .where(eq(quotes.id, quoteId))
        .returning();
      if (!rows[0]) {
        throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
          resourceType: "quote",
          resourceId: quoteId,
        });
      }
      await appendAudit(tx, ctx, {
        action: "QUOTE_CONFIRMED",
        entityType: "quote",
        entityId: quoteId,
        before: { status: current.status, totalAmount: current.total.amount },
        after: { status: "SENT", confirmedBy: ctx.actor.id },
      });
    });
    return {
      quoteId,
      status: "SENT",
      confirmedBy: ctx.actor.id,
      confirmedAt: confirmedAt.toISOString(),
    };
  }

  /** 审批队列 / 全景的只读视图：把账本里的报价单映射成 ApprovalItem。 */
  async list(limit = 50): Promise<ApprovalItem[]> {
    const rows = await this.db.select().from(quotes).orderBy(desc(quotes.createdAt)).limit(limit);
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const itemRows = await this.db
      .select({ quoteId: quoteItems.quoteId })
      .from(quoteItems)
      .where(inArray(quoteItems.quoteId, ids));
    const countBy = new Map<string, number>();
    for (const item of itemRows) {
      countBy.set(item.quoteId, (countBy.get(item.quoteId) ?? 0) + 1);
    }

    return rows.map((row) =>
      ApprovalItem.parse({
        id: row.id,
        kind: "quote",
        title: `报价单 · ${row.id.slice(0, 8)}`,
        summary: `${countBy.get(row.id) ?? 0} 行 · ${formatMoney({ amount: row.totalAmount, currency: currencyOf(row.currency) })}`,
        status: row.status,
        pending: row.status === "DRAFT",
        amountCents: row.totalAmount,
        currency: currencyOf(row.currency),
        customerId: row.customerId,
        createdAt: toIso(row.createdAt),
        confirmedBy: row.confirmedBy ?? null,
      }),
    );
  }

  /**
   * 人类在审批窗口驳回报价草稿：DRAFT -> REJECTED，同事务写审计。
   * 智能体无权驳回；只有 DRAFT 能被驳回（getDraft 强制校验）。
   */
  async rejectDraft(
    quoteId: string,
    ctx: KernelContext,
    note?: string,
  ): Promise<{ status: "REJECTED" }> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "报价驳回必须由人类在审批窗口执行，智能体无权驳回",
      );
    }
    const current = await this.getDraft(quoteId);
    const rejectedAt = new Date();
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(quotes)
        .set({ status: "REJECTED", updatedAt: rejectedAt })
        .where(eq(quotes.id, quoteId))
        .returning();
      if (!rows[0]) {
        throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
          resourceType: "quote",
          resourceId: quoteId,
        });
      }
      await appendAudit(tx, ctx, {
        action: "QUOTE_REJECTED",
        entityType: "quote",
        entityId: quoteId,
        before: { status: current.status, totalAmount: current.total.amount },
        after: { status: "REJECTED", confirmedBy: ctx.actor.id, note: note ?? null },
      });
    });
    return { status: "REJECTED" };
  }
}
