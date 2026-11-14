import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql, sum } from "drizzle-orm";
import {
  CreateInvoiceInput,
  Invoice,
  InvoiceActionInput,
  InvoiceSettings,
  InvoiceSettingsInput,
  IssueInvoiceInput,
  TaxProfile,
  TaxProfileInput,
} from "@weave-order/schema";
import type { InvoiceStatus, Refund } from "@weave-order/schema";
import {
  invoiceSettings,
  invoices,
  plans,
  refunds,
  subscriptions,
  taxProfiles,
  tenants,
  usageDaily,
} from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import type { PlatformActor } from "../auth/auth.service";
import { conflict, invalid, notFound } from "../domain/errors";
import { buildInvoiceLines, invoiceTotals } from "../domain/billing";
import { AuditService } from "./audit.service";
import { addDays, toIso } from "./util";

export interface InvoiceListFilter {
  tenantId?: string;
  status?: InvoiceStatus;
}

export interface InvoiceSettingsUpdate {
  input: unknown;
  reason?: string;
}

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: PlatformDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(filter: InvoiceListFilter = {}): Promise<Invoice[]> {
    await this.refreshOverdue();
    const where = [];
    if (filter.tenantId) where.push(eq(invoices.tenantId, filter.tenantId));
    if (filter.status) where.push(eq(invoices.status, filter.status));
    const rows = await this.db
      .select({ invoice: invoices, tenantName: tenants.name })
      .from(invoices)
      .innerJoin(tenants, eq(tenants.id, invoices.tenantId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(invoices.createdAt))
      .limit(200);
    return rows.map((row) => this.mapInvoice(row.invoice, row.tenantName));
  }

  async get(id: string): Promise<Invoice> {
    const rows = await this.db
      .select({ invoice: invoices, tenantName: tenants.name })
      .from(invoices)
      .innerJoin(tenants, eq(tenants.id, invoices.tenantId))
      .where(eq(invoices.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("发票不存在");
    return this.mapInvoice(row.invoice, row.tenantName);
  }

  async create(actor: PlatformActor, raw: unknown): Promise<Invoice> {
    const input = CreateInvoiceInput.parse(raw);
    const rows = await this.db
      .select({ tenant: tenants, subscription: subscriptions, plan: plans })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("租户不存在");
    if (!row.subscription) throw invalid("租户没有订阅，无法出账");
    if (row.tenant.status === "CANCELLED") throw invalid("已注销租户不能再出账");

    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    if (periodEnd <= periodStart) throw invalid("账期结束必须晚于开始");

    const usageRows = await this.db
      .select({ actions: sum(usageDaily.agentActions) })
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.tenantId, input.tenantId),
          gte(usageDaily.day, periodStart.toISOString().slice(0, 10)),
          lte(usageDaily.day, periodEnd.toISOString().slice(0, 10)),
        ),
      );
    const usedActions = Number(usageRows[0]?.actions ?? 0);

    const profile = await this.db
      .select()
      .from(taxProfiles)
      .where(eq(taxProfiles.tenantId, input.tenantId))
      .limit(1);
    const settings = await this.getSettings();
    const taxRateBp = profile[0]?.taxRateBp ?? settings.taxRateBp;

    // 按套餐订阅（按公司）计费：整期一个价，不再乘席位数。
    const monthlyUnit = row.subscription.effectiveMonthlyCents;
    const periodPriceCents =
      row.subscription.billingCycle === "ANNUAL" ? monthlyUnit * 10 : monthlyUnit;
    const draft = buildInvoiceLines({
      seats: row.subscription.seats,
      seatUnitCents: periodPriceCents,
      flatPriceCents: periodPriceCents,
      billingCycle: row.subscription.billingCycle,
      usedActions,
      actionQuota: row.plan?.agentActionsQuota ?? 0,
      adjustments: input.adjustments,
    });
    const { taxCents, totalCents } = invoiceTotals(draft.subtotalCents, taxRateBp);

    const seqRows = await this.db.execute<{ number: string }>(
      sql`SELECT 'INV-' || to_char(now(), 'YYYYMM') || '-' || nextval('control.invoice_number_seq') AS number`,
    );
    const number = seqRows.rows[0]?.number;
    if (!number) throw new Error("发票号生成失败");

    const created = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(invoices)
        .values({
          tenantId: input.tenantId,
          number,
          status: "DRAFT",
          periodStart,
          periodEnd,
          subtotalCents: draft.subtotalCents,
          taxRateBp,
          taxCents,
          totalCents,
          currency: row.tenant.currency as Invoice["currency"],
          lineItems: draft.lineItems,
          notes: input.notes ?? null,
          createdBy: actor.sub,
        })
        .returning();
      return rows[0];
    });
    if (!created) throw new Error("发票创建失败");

    await this.audit.record(actor, {
      action: "INVOICE_DRAFTED",
      targetType: "invoice",
      targetId: created.id,
      after: {
        number,
        tenantId: input.tenantId,
        subtotalCents: draft.subtotalCents,
        taxCents,
        totalCents,
      },
      reason: "创建账单草稿",
    });
    return this.mapInvoice(created, row.tenant.name);
  }

  async issue(actor: PlatformActor, id: string, raw: unknown): Promise<Invoice> {
    const input = IssueInvoiceInput.parse(raw ?? {});
    const invoice = await this.rowOrThrow(id);
    if (invoice.status !== "DRAFT") throw conflict(`只有草稿可开具，当前 ${invoice.status}`);
    const now = new Date();
    const dueAt = input.dueAt ? new Date(input.dueAt) : addDays(now, 14);
    const updated = await this.db
      .update(invoices)
      .set({ status: "ISSUED", issuedAt: now, dueAt, updatedAt: now })
      .where(eq(invoices.id, id))
      .returning();
    await this.audit.record(actor, {
      action: "INVOICE_ISSUED",
      targetType: "invoice",
      targetId: id,
      before: { status: invoice.status },
      after: { status: "ISSUED", dueAt: dueAt.toISOString(), number: invoice.number },
      reason: "开具发票",
    });
    return this.getUpdated(id, updated[0]);
  }

  async markPaid(actor: PlatformActor, id: string, raw: unknown): Promise<Invoice> {
    InvoiceActionInput.parse(raw ?? {});
    const invoice = await this.rowOrThrow(id);
    if (!["ISSUED", "OVERDUE"].includes(invoice.status)) {
      throw conflict(`当前状态不可登记回款：${invoice.status}`);
    }
    const now = new Date();
    const updated = await this.db
      .update(invoices)
      .set({ status: "PAID", paidAt: now, updatedAt: now })
      .where(eq(invoices.id, id))
      .returning();
    await this.audit.record(actor, {
      action: "INVOICE_PAID",
      targetType: "invoice",
      targetId: id,
      before: { status: invoice.status },
      after: { status: "PAID", paidAt: now.toISOString() },
      reason: "登记回款",
    });
    return this.getUpdated(id, updated[0]);
  }

  /** 红冲：必须由审批执行器调用（财务复核），控制器只创建申请。 */
  async voidInvoice(actor: PlatformActor, id: string, reason: string): Promise<Invoice> {
    const invoice = await this.rowOrThrow(id);
    if (invoice.status === "VOID" || invoice.status === "RED_FLUSH") {
      throw conflict("该发票已红冲");
    }
    const now = new Date();
    const updated = await this.db
      .update(invoices)
      .set({ status: "RED_FLUSH", approvedBy: actor.sub, updatedAt: now })
      .where(eq(invoices.id, id))
      .returning();
    await this.audit.record(actor, {
      action: "INVOICE_RED_FLUSHED",
      targetType: "invoice",
      targetId: id,
      before: { status: invoice.status, totalCents: invoice.totalCents },
      after: { status: "RED_FLUSH", approvedBy: actor.sub },
      reason,
    });
    return this.getUpdated(id, updated[0]);
  }

  /** 退款是资金出账：只能由审批执行器调用（owner + finance 双人复核后）。 */
  async applyRefund(
    actor: PlatformActor,
    invoiceId: string,
    amountCents: number,
    reason: string,
  ): Promise<Refund> {
    const invoice = await this.rowOrThrow(invoiceId);
    if (invoice.status !== "PAID") throw conflict("只有已回款的发票可以退款");
    const refundedRows = await this.db
      .select({ total: sum(refunds.amountCents) })
      .from(refunds)
      .where(and(eq(refunds.invoiceId, invoiceId), eq(refunds.status, "APPROVED")));
    const refunded = Number(refundedRows[0]?.total ?? 0);
    if (amountCents <= 0) throw invalid("退款金额必须为正整数分");
    if (refunded + amountCents > invoice.totalCents) {
      throw invalid(`退款超过可退金额：已退 ${refunded} 分，发票总额 ${invoice.totalCents} 分`);
    }
    const rows = await this.db
      .insert(refunds)
      .values({
        invoiceId,
        tenantId: invoice.tenantId,
        amountCents,
        reason,
        status: "APPROVED",
        requestedBy: invoice.createdBy,
        approvedBy: actor.sub,
      })
      .returning();
    const refund = rows[0];
    if (!refund) throw new Error("退款写入失败");
    await this.audit.record(actor, {
      action: "INVOICE_REFUNDED",
      targetType: "invoice",
      targetId: invoiceId,
      after: { refundId: refund.id, amountCents, refundedTotal: refunded + amountCents, reason },
      reason,
    });
    return mapRefund(refund);
  }

  async listRefunds(invoiceId: string): Promise<Refund[]> {
    await this.rowOrThrow(invoiceId);
    const rows = await this.db
      .select()
      .from(refunds)
      .where(eq(refunds.invoiceId, invoiceId))
      .orderBy(desc(refunds.createdAt));
    return rows.map(mapRefund);
  }

  async getSettings(): Promise<InvoiceSettings> {
    await this.db.insert(invoiceSettings).values({ id: "default" }).onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(invoiceSettings)
      .where(eq(invoiceSettings.id, "default"))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("开票设置缺失");
    return InvoiceSettings.parse({
      invoiceType: row.invoiceType,
      taxRateBp: row.taxRateBp,
      priceDisplay: row.priceDisplay,
      issuerEntity: row.issuerEntity,
      issueTiming: row.issueTiming,
      redFlushRule: row.redFlushRule,
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  /** 由审批执行器或非税率字段更新时调用。 */
  async applySettings(
    actor: PlatformActor,
    raw: unknown,
    reason?: string,
  ): Promise<InvoiceSettings> {
    const input = InvoiceSettingsInput.parse(raw);
    const before = await this.getSettings();
    const now = new Date();
    const rows = await this.db
      .update(invoiceSettings)
      .set({
        invoiceType: input.invoiceType ?? before.invoiceType,
        taxRateBp: input.taxRateBp ?? before.taxRateBp,
        priceDisplay: input.priceDisplay ?? before.priceDisplay,
        issuerEntity: input.issuerEntity ?? before.issuerEntity,
        issueTiming: input.issueTiming ?? before.issueTiming,
        redFlushRule: input.redFlushRule ?? before.redFlushRule,
        version: before.version + 1,
        updatedBy: actor.sub,
        updatedAt: now,
      })
      .where(eq(invoiceSettings.id, "default"))
      .returning();
    const row = rows[0];
    if (!row) throw new Error("开票设置更新失败");
    await this.audit.record(actor, {
      action: "INVOICE_SETTINGS_UPDATED",
      targetType: "invoice_settings",
      targetId: "default",
      before: {
        taxRateBp: before.taxRateBp,
        invoiceType: before.invoiceType,
        issuerEntity: before.issuerEntity,
        issueTiming: before.issueTiming,
        redFlushRule: before.redFlushRule,
        version: before.version,
      },
      after: { ...input, version: row.version },
      reason: reason ?? input.reason ?? "更新开票设置",
    });
    return this.getSettings();
  }

  async getTaxProfile(tenantId: string): Promise<TaxProfile | null> {
    const rows = await this.db
      .select()
      .from(taxProfiles)
      .where(eq(taxProfiles.tenantId, tenantId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          tenantId: row.tenantId,
          title: row.title,
          taxNo: row.taxNo,
          bank: row.bank,
          address: row.address,
          invoiceType: row.invoiceType,
          taxRateBp: row.taxRateBp,
        }
      : null;
  }

  async upsertTaxProfile(actor: PlatformActor, raw: unknown): Promise<TaxProfile> {
    const input = TaxProfileInput.parse(raw);
    if (!(await this.tenantExists(input.tenantId))) throw notFound("租户不存在");
    await this.db
      .insert(taxProfiles)
      .values({ ...input, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: taxProfiles.tenantId,
        set: {
          title: input.title,
          taxNo: input.taxNo,
          bank: input.bank,
          address: input.address,
          invoiceType: input.invoiceType,
          taxRateBp: input.taxRateBp,
          updatedAt: new Date(),
        },
      });
    await this.audit.record(actor, {
      action: "TAX_PROFILE_UPDATED",
      targetType: "tax_profile",
      targetId: input.tenantId,
      after: input,
      reason: "更新租户开票资料",
    });
    return (await this.getTaxProfile(input.tenantId)) as TaxProfile;
  }

  private async refreshOverdue(): Promise<void> {
    const now = new Date();
    await this.db
      .update(invoices)
      .set({ status: "OVERDUE", updatedAt: now })
      .where(and(eq(invoices.status, "ISSUED"), lte(invoices.dueAt, now)));
  }

  private async rowOrThrow(id: string): Promise<typeof invoices.$inferSelect> {
    const rows = await this.db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound("发票不存在");
    return row;
  }

  private async getUpdated(
    id: string,
    updated: typeof invoices.$inferSelect | undefined,
  ): Promise<Invoice> {
    if (!updated) return this.get(id);
    const tenantRows = await this.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, updated.tenantId))
      .limit(1);
    return this.mapInvoice(updated, tenantRows[0]?.name ?? updated.tenantId);
  }

  private async tenantExists(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    return Boolean(rows[0]);
  }

  private mapInvoice(row: typeof invoices.$inferSelect, tenantName: string): Invoice {
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantName,
      number: row.number,
      status: row.status,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      dueAt: toIso(row.dueAt),
      issuedAt: toIso(row.issuedAt),
      paidAt: toIso(row.paidAt),
      subtotalCents: row.subtotalCents,
      taxRateBp: row.taxRateBp,
      taxCents: row.taxCents,
      totalCents: row.totalCents,
      currency: row.currency as Invoice["currency"],
      lineItems: row.lineItems as Invoice["lineItems"],
      notes: row.notes,
      createdBy: row.createdBy,
      approvedBy: row.approvedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function mapRefund(row: typeof refunds.$inferSelect): Refund {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    tenantId: row.tenantId,
    amountCents: row.amountCents,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
  };
}
