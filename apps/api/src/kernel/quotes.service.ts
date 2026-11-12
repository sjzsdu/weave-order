import { quoteItems, quotes } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { ApprovalItem, T004GenerateQuoteDraftInput } from "@weave-order/schema";
import type { QuoteConfirmation, QuoteDraft, QuoteLineItem } from "@weave-order/schema";
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

const DAY_MS = 24 * 60 * 60 * 1000;

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

  async getDraft(quoteId: string): Promise<QuoteDraft> {
    const rows = await this.db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
        resourceType: "quote",
        resourceId: quoteId,
      });
    }
    if (row.status !== "DRAFT") {
      throw new KernelError("KERNEL_REJECTED", `报价单不是草稿状态：${row.status}`, {
        reason: "INVALID_STATE_TRANSITION",
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
    return mapQuote(row, items);
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
