import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { Overview } from "@weave-order/schema";
import type { Overview as OverviewType } from "@weave-order/schema";
import {
  approvals,
  invoices,
  plans,
  subscriptions,
  supportTickets,
  tenants,
  usageDaily,
} from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import { grossMarginBps } from "../domain/billing";
import { monthStart } from "./util";

@Injectable()
export class OverviewService {
  constructor(@Inject(PLATFORM_DATABASE) private readonly db: PlatformDb) {}

  async get(): Promise<OverviewType> {
    const now = new Date();
    const month = monthStart(now);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      tenantRows,
      subRows,
      planRows,
      revenueRows,
      costRows,
      overdueRows,
      pendingRows,
      incidentRows,
    ] = await Promise.all([
      this.db.select().from(tenants),
      this.db.select().from(subscriptions),
      this.db.select().from(plans),
      this.db
        .select({ total: sql<string>`coalesce(sum(${invoices.totalCents}), 0)` })
        .from(invoices)
        .where(and(eq(invoices.status, "PAID"), gte(invoices.paidAt, new Date(month)))),
      this.db
        .select({ total: sql<string>`coalesce(sum(${usageDaily.llmCostCents}), 0)` })
        .from(usageDaily)
        .where(gte(usageDaily.day, month)),
      this.db
        .select({ count: sql<string>`count(*)` })
        .from(invoices)
        .where(inArray(invoices.status, ["ISSUED", "OVERDUE"])),
      this.db
        .select({ count: sql<string>`count(*)` })
        .from(approvals)
        .where(eq(approvals.status, "PENDING")),
      this.db
        .select({ count: sql<string>`count(*)` })
        .from(supportTickets)
        .where(inArray(supportTickets.status, ["OPEN", "PENDING"])),
    ]);

    const planByCode = new Map(planRows.map((plan) => [plan.code, plan]));
    const active = tenantRows.filter((tenant) => tenant.status === "ACTIVE");
    const trial = tenantRows.filter((tenant) => tenant.status === "TRIAL");
    const cancelled = tenantRows.filter(
      (tenant) =>
        tenant.status === "CANCELLED" && tenant.churnedAt && tenant.churnedAt >= thirtyDaysAgo,
    );

    let mrrCents = 0;
    for (const subscription of subRows) {
      if (!["ACTIVE", "OVERDUE"].includes(subscription.status)) continue;
      const plan = planByCode.get(subscription.planCode);
      if (plan?.tier === 3) continue; // Enterprise 合同价单独计，不混入标准 MRR
      mrrCents += subscription.effectiveMonthlyCents;
    }

    const converted = tenantRows.filter((tenant) => tenant.convertedAt).length;
    const churned = tenantRows.filter((tenant) => tenant.churnedAt).length;
    const conversionDenominator = converted + churned;
    const revenueCents = Number(revenueRows[0]?.total ?? 0);
    const llmCostCents = Number(costRows[0]?.total ?? 0);

    const funnel = [
      { stage: "开通试用", count: tenantRows.filter((tenant) => tenant.trialStartedAt).length },
      { stage: "转正式", count: converted },
      { stage: "30 天流失", count: cancelled.length },
    ];

    return Overview.parse({
      mrrCents,
      arrCents: mrrCents * 12,
      activeTenants: active.length,
      trialTenants: trial.length,
      trialConversionRate:
        conversionDenominator > 0 ? Math.round((converted / conversionDenominator) * 100) / 100 : 0,
      churnedLast30d: cancelled.length,
      grossMarginBps: grossMarginBps(revenueCents, llmCostCents),
      llmCostCentsThisMonth: llmCostCents,
      revenueCentsThisMonth: revenueCents,
      openIncidents: Number(incidentRows[0]?.count ?? 0),
      overdueInvoices: Number(overdueRows[0]?.count ?? 0),
      pendingApprovals: Number(pendingRows[0]?.count ?? 0),
      trialFunnel: funnel,
    });
  }
}

void lt;
