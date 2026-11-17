import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, ilike, lte, or, sum } from "drizzle-orm";
import {
  ChangeSubscriptionInput,
  ProvisionTenantInput,
  TenantDetail,
  TenantStatusInput,
  TenantSummary,
} from "@weave-order/schema";
import type {
  Plan,
  PlatformTenantStatus,
  Subscription,
  TenantPriceOverride,
  UsageDay,
} from "@weave-order/schema";
import {
  featureFlags,
  llmSettings,
  plans,
  planPrices,
  priceBooks,
  subscriptions,
  taxProfiles,
  tenantPriceOverrides,
  tenants,
  usageDaily,
} from "@weave-order/control-db";
import type { PlanRow, SubscriptionRow, TenantRow } from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import type { PlatformActor } from "../auth/auth.service";
import { conflict, invalid, notFound } from "../domain/errors";
import { effectiveMonthlyCents } from "../domain/billing";
import { loadEnv } from "../env";
import { AuditService } from "./audit.service";
import { ONBOARDING_TICKET_TTL_SECONDS, signOnboardingTicket } from "./onboarding-ticket";
import { addDays, addMonths, currentMonthPeriod, toIso } from "./util";

export interface TenantListFilter {
  q?: string;
  status?: PlatformTenantStatus;
  planCode?: string;
}

export interface ApplySubscriptionOptions {
  overrideMonthlyPriceCents?: number;
  overrideId?: string | null;
  forceReason?: string;
}

/** 控制面租户目录：只有账号 / 订阅 / 用量聚合，绝不读租户业务库。 */
@Injectable()
export class TenantsService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: PlatformDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * 对账用：返回控制面已知的租户 slug + 状态，给业务侧比对「业务库有、控制面无」的漂移。
   * 只读，不触碰业务库；由内部共享密钥接口调用，非运营 UI 数据源。
   */
  async listControlSlugs(): Promise<{ slug: string; status: PlatformTenantStatus }[]> {
    const rows = await this.db.select({ slug: tenants.slug, status: tenants.status }).from(tenants);
    return rows.map((row) => ({ slug: row.slug, status: row.status }));
  }

  async list(filter: TenantListFilter = {}): Promise<TenantSummary[]> {
    const where = [];
    if (filter.q) {
      where.push(or(ilike(tenants.name, `%${filter.q}%`), ilike(tenants.slug, `%${filter.q}%`)));
    }
    if (filter.status) where.push(eq(tenants.status, filter.status));

    const rows = await this.db
      .select({
        tenant: tenants,
        subscription: subscriptions,
        plan: plans,
      })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(tenants.createdAt));

    const usage = await this.monthUsage();
    return rows
      .filter((row) => !filter.planCode || row.subscription?.planCode === filter.planCode)
      .map((row) =>
        this.mapSummary(row.tenant, row.subscription, row.plan, usage.get(row.tenant.id) ?? 0),
      );
  }

  async get(id: string): Promise<TenantDetail> {
    const rows = await this.db
      .select({ tenant: tenants, subscription: subscriptions, plan: plans })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(eq(tenants.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("租户不存在");

    const [usage, overrides, tax, llm, flags] = await Promise.all([
      this.usageDays(id, 30),
      this.db
        .select()
        .from(tenantPriceOverrides)
        .where(eq(tenantPriceOverrides.tenantId, id))
        .orderBy(desc(tenantPriceOverrides.createdAt)),
      this.db.select().from(taxProfiles).where(eq(taxProfiles.tenantId, id)).limit(1),
      this.db
        .select()
        .from(llmSettings)
        .where(and(eq(llmSettings.scope, "TENANT"), eq(llmSettings.tenantId, id)))
        .limit(1),
      this.db.select().from(featureFlags).where(eq(featureFlags.enabled, true)),
    ]);

    const flagKeys = flags
      .filter((flag) => flag.tenantIds.includes(id) || flag.rolloutPercent > 0)
      .map((flag) => flag.key);

    return TenantDetail.parse({
      tenant: this.mapSummary(
        row.tenant,
        row.subscription,
        row.plan,
        usage.reduce((total, day) => total + day.agentActions, 0),
      ),
      subscription: row.subscription ? this.mapSubscription(row.subscription) : null,
      plan: row.plan ? this.mapPlan(row.plan) : null,
      usage,
      overrides: overrides.map((item) => this.mapOverride(item)),
      taxProfile: tax[0]
        ? {
            tenantId: tax[0].tenantId,
            title: tax[0].title,
            taxNo: tax[0].taxNo,
            bank: tax[0].bank,
            address: tax[0].address,
            invoiceType: tax[0].invoiceType,
            taxRateBp: tax[0].taxRateBp,
          }
        : null,
      llmOverride: llm[0]
        ? {
            scope: "TENANT",
            tenantId: id,
            provider: llm[0].provider,
            baseUrl: llm[0].baseUrl,
            defaultModel: llm[0].defaultModel,
            dailyTokenBudget: llm[0].dailyTokenBudget,
            monthlyTokenBudget: llm[0].monthlyTokenBudget,
            keyRef: llm[0].keyRef,
            allowExternal: llm[0].allowExternal,
            version: llm[0].version,
            updatedBy: llm[0].updatedBy,
            updatedAt: llm[0].updatedAt.toISOString(),
          }
        : null,
      featureFlags: flagKeys,
      notes: row.tenant.notes,
      contactName: row.tenant.contactName,
      contactEmail: row.tenant.contactEmail,
    });
  }

  /** 开通公司：租户 + 试用订阅 + 审计，一个事务内完成。 */
  async provision(actor: PlatformActor, raw: unknown): Promise<TenantSummary> {
    const input = ProvisionTenantInput.parse(raw);
    const planRow = await this.planOrThrow(input.planCode);
    // 按套餐订阅：账号数由套餐内含（seatMin），不再接受「加座加钱」。
    // 入参 seats 只保留兼容，不参与计费，也不允许超过套餐上限。
    const includedSeats = planRow.seatMin;
    if (planRow.seatMax !== null && input.seats > planRow.seatMax) {
      this.assertSeats(planRow, input.seats);
    }

    const book = await this.activePriceBook();
    const price = await this.priceFor(book.id, input.planCode);
    const now = new Date();
    const trialEnds = addDays(now, input.trialDays);
    const periodEnd = input.trialDays > 0 ? trialEnds : addMonths(now, 1);
    const monthly = effectiveMonthlyCents(
      { monthlyPriceCents: price.monthlyPriceCents, annualPriceCents: price.annualPriceCents },
      input.billingCycle,
    );

    try {
      const created = await this.db.transaction(async (tx) => {
        const tenantRows = await tx
          .insert(tenants)
          .values({
            name: input.name,
            slug: input.slug,
            status: input.trialDays > 0 ? "TRIAL" : "ACTIVE",
            isolationMode: input.isolationMode,
            region: input.region,
            notes: input.notes ?? null,
            contactName: input.contactName ?? null,
            contactEmail: input.contactEmail ?? null,
            trialStartedAt: now,
            convertedAt: input.trialDays > 0 ? null : now,
          })
          .returning();
        const tenant = tenantRows[0];
        if (!tenant) throw new Error("租户创建失败");

        await tx.insert(subscriptions).values({
          tenantId: tenant.id,
          planCode: input.planCode,
          priceBookId: book.id,
          seats: includedSeats,
          billingCycle: input.billingCycle,
          status: input.trialDays > 0 ? "TRIAL" : "ACTIVE",
          periodStart: now,
          periodEnd,
          trialEndsAt: input.trialDays > 0 ? trialEnds : null,
          nextDueAt: input.trialDays > 0 ? trialEnds : periodEnd,
          effectiveMonthlyCents: monthly,
        });

        return tenant;
      });

      await this.audit.record(actor, {
        action: "TENANT_PROVISIONED",
        targetType: "tenant",
        targetId: created.id,
        after: {
          name: created.name,
          slug: created.slug,
          planCode: input.planCode,
          seats: includedSeats,
          trialDays: input.trialDays,
        },
        reason: "平台开通公司",
      });

      return (await this.list()).find((item) => item.id === created.id) as TenantSummary;
    } catch (error) {
      if (error instanceof Error && /duplicate key/.test(error.message)) {
        throw conflict(`租户标识 ${input.slug} 已存在`);
      }
      throw error;
    }
  }

  /**
   * 自助开通登记：租户端建好公司后调这里补一条控制面记录（租户 + 3 天试用）。
   *
   * 幂等：同一个 slug 已存在就直接返回，不重复建订阅。
   * 失败也不会让业务侧回滚——用户已经能用了，运营按 slug 补录即可。
   */
  async registerTrialTenant(input: {
    slug: string;
    name: string;
    ownerEmail?: string | null;
  }): Promise<{ tenantId: string; slug: string; created: boolean }> {
    const existing = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, input.slug))
      .limit(1);
    if (existing[0]) {
      return { tenantId: existing[0].id, slug: input.slug, created: false };
    }

    const planRows = await this.db
      .select()
      .from(plans)
      .where(eq(plans.status, "ACTIVE"))
      .orderBy(plans.tier)
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      throw invalid("控制面还没有可用套餐，无法登记试用租户");
    }

    const actor: PlatformActor = {
      id: "self-serve",
      sub: "self-serve",
      name: "自助开通",
      email: "noreply@weaveorder.cn",
      role: "platform_owner",
      permissions: [],
    };
    const created = await this.provision(actor, {
      name: input.name,
      slug: input.slug,
      planCode: plan.code,
      seats: Math.max(1, plan.seatMin),
      billingCycle: "MONTHLY",
      trialDays: 3,
      contactEmail: input.ownerEmail ?? undefined,
      notes: "自助开通（租户端创建，控制面补登记）",
    });
    return { tenantId: created.id, slug: input.slug, created: true };
  }

  /**
   * 改套餐 / 席位 / 账期。升级即时生效，降级同样立即（MVP 简化，账期折算在
   * 下一张账单体现）；强制定价由调用方先走双人复核，再带 override 调用。
   */
  async applySubscription(
    actor: PlatformActor,
    tenantId: string,
    input: unknown,
    options: ApplySubscriptionOptions = {},
  ): Promise<Subscription> {
    const parsed = ChangeSubscriptionInput.parse(input);
    const tenant = await this.tenantOrThrow(tenantId);
    const planRow = await this.planOrThrow(parsed.planCode);
    // 按套餐订阅：账号数随套餐，不再单独售卖席位。
    const includedSeats = planRow.seatMin;
    if (planRow.seatMax !== null && parsed.seats > planRow.seatMax) {
      this.assertSeats(planRow, parsed.seats);
    }
    const book = await this.activePriceBook();
    const price = await this.priceFor(book.id, parsed.planCode);

    const monthly =
      options.overrideMonthlyPriceCents !== undefined
        ? options.overrideMonthlyPriceCents
        : effectiveMonthlyCents(
            {
              monthlyPriceCents: price.monthlyPriceCents,
              annualPriceCents: price.annualPriceCents,
            },
            parsed.billingCycle,
          );

    const existing = await this.subscriptionOf(tenantId);
    const now = new Date();
    const periodEnd = addMonths(now, parsed.billingCycle === "ANNUAL" ? 12 : 1);

    const nextStatus: "ACTIVE" | "SUSPENDED" | "OVERDUE" =
      tenant.status === "SUSPENDED"
        ? "SUSPENDED"
        : tenant.status === "OVERDUE"
          ? "OVERDUE"
          : "ACTIVE";

    const updated = await this.db.transaction(async (tx) => {
      const values = {
        planCode: parsed.planCode,
        priceBookId: book.id,
        seats: includedSeats,
        billingCycle: parsed.billingCycle,
        status: nextStatus,
        effectiveMonthlyCents: monthly,
        overrideId: options.overrideId ?? null,
        periodStart: now,
        periodEnd,
        nextDueAt: tenant.status === "TRIAL" ? (existing?.trialEndsAt ?? periodEnd) : periodEnd,
        updatedAt: now,
      };
      const rows = existing
        ? await tx
            .update(subscriptions)
            .set(values)
            .where(eq(subscriptions.tenantId, tenantId))
            .returning()
        : await tx
            .insert(subscriptions)
            .values({ tenantId, ...values })
            .returning();
      const row = rows[0];
      if (!row) throw new Error("订阅写入失败");

      if (tenant.status === "TRIAL" || tenant.status === "ACTIVE") {
        await tx
          .update(tenants)
          .set({
            status: "ACTIVE",
            convertedAt: tenant.convertedAt ?? now,
            updatedAt: now,
          })
          .where(eq(tenants.id, tenantId));
      }
      return row;
    });

    await this.audit.record(actor, {
      action: "SUBSCRIPTION_CHANGED",
      targetType: "tenant",
      targetId: tenantId,
      before: existing
        ? { planCode: existing.planCode, seats: existing.seats, cycle: existing.billingCycle }
        : null,
      after: {
        planCode: parsed.planCode,
        seats: includedSeats,
        cycle: parsed.billingCycle,
        effectiveMonthlyCents: monthly,
        forced: options.overrideMonthlyPriceCents !== undefined,
        reason: options.forceReason ?? parsed.reason ?? null,
      },
      reason: options.forceReason ?? parsed.reason ?? "平台改套餐",
    });

    return this.mapSubscription(updated);
  }

  async setStatus(actor: PlatformActor, tenantId: string, raw: unknown): Promise<TenantSummary> {
    const input = TenantStatusInput.parse(raw);
    const tenant = await this.tenantOrThrow(tenantId);
    const now = new Date();
    const nextSubscription = input.status === "SUSPENDED" ? "SUSPENDED" : input.status;
    if (tenant.status === input.status) throw invalid(`租户已是 ${input.status} 状态`);

    await this.db.transaction(async (tx) => {
      await tx
        .update(tenants)
        .set({
          status: input.status,
          suspendedAt: input.status === "SUSPENDED" ? now : null,
          cancelledAt: input.status === "CANCELLED" ? now : null,
          churnedAt: input.status === "CANCELLED" ? now : tenant.churnedAt,
          updatedAt: now,
        })
        .where(eq(tenants.id, tenantId));
      await tx
        .update(subscriptions)
        .set({ status: nextSubscription, updatedAt: now })
        .where(eq(subscriptions.tenantId, tenantId));
    });

    await this.audit.record(actor, {
      action: `TENANT_${input.status}`,
      targetType: "tenant",
      targetId: tenantId,
      before: { status: tenant.status },
      after: { status: input.status },
      reason: input.reason,
    });

    const detail = await this.get(tenantId);
    return detail.tenant;
  }

  /**
   * 注销/清数据：控制面只匿名化账号并保留账单（合规要求），
   * 租户业务库的物理删除属于运维 runbook，不在控制面执行（控制面没有该连接）。
   */
  async purge(actor: PlatformActor, tenantId: string, reason: string): Promise<void> {
    const tenant = await this.tenantOrThrow(tenantId);
    const anonymized = `已注销-${tenant.id.slice(0, 8)}`;
    await this.db.transaction(async (tx) => {
      await tx
        .update(tenants)
        .set({
          name: anonymized,
          status: "CANCELLED",
          contactName: null,
          contactEmail: null,
          notes: "已按双人复核完成账号注销；账单与审计按合规保留",
          cancelledAt: new Date(),
          churnedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));
      await tx
        .update(subscriptions)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(subscriptions.tenantId, tenantId));
    });
    await this.audit.record(actor, {
      action: "TENANT_PURGED",
      targetType: "tenant",
      targetId: tenantId,
      before: { name: tenant.name, status: tenant.status },
      after: { name: anonymized, status: "CANCELLED" },
      reason,
    });
  }

  async planOrThrow(code: string): Promise<PlanRow> {
    const rows = await this.db.select().from(plans).where(eq(plans.code, code)).limit(1);
    const plan = rows[0];
    if (!plan) throw notFound(`套餐不存在：${code}`);
    if (plan.status !== "ACTIVE") throw invalid(`套餐已停售：${code}`);
    return plan;
  }

  async tenantOrThrow(id: string): Promise<TenantRow> {
    const rows = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    const tenant = rows[0];
    if (!tenant) throw notFound("租户不存在");
    return tenant;
  }

  /**
   * 生成开通链接：客户老板打开后，用统一账号登录即可把公司空间建出来。
   *
   * 只做签名，不写业务库——控制面碰不到业务数据。链接里的信息只有
   * slug / 公司名 / 联系人邮箱 / 过期时间，见 `packages/schema/src/onboarding.ts`。
   */
  async onboardingLink(
    actor: PlatformActor,
    tenantId: string,
  ): Promise<{
    url: string;
    code: string;
    expiresAt: string;
    slug: string;
    name: string;
    ownerEmail: string | null;
  }> {
    const tenant = await this.tenantOrThrow(tenantId);
    const env = loadEnv();
    const ownerEmail = tenant.contactEmail ?? null;
    const code = signOnboardingTicket(
      {
        v: 1,
        slug: tenant.slug,
        name: tenant.name,
        ownerEmail,
      },
      env.ONBOARDING_SECRET,
    );
    const expiresAt = new Date(Date.now() + ONBOARDING_TICKET_TTL_SECONDS * 1000).toISOString();
    const url = `${env.WEB_APP_URL.replace(/\/$/, "")}/activate?code=${encodeURIComponent(code)}`;

    await this.audit.record(actor, {
      action: "ONBOARDING_LINK_ISSUED",
      targetType: "tenant",
      targetId: tenant.id,
      after: { slug: tenant.slug, ownerEmail, expiresAt },
      reason: "生成客户开通链接",
    });

    return { url, code, expiresAt, slug: tenant.slug, name: tenant.name, ownerEmail };
  }

  private async subscriptionOf(tenantId: string): Promise<SubscriptionRow | null> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .limit(1);
    return rows[0] ?? null;
  }

  async activePriceBook(): Promise<{ id: string; version: number; effectiveFrom: Date }> {
    const rows = await this.db
      .select()
      .from(priceBooks)
      .where(eq(priceBooks.status, "ACTIVE"))
      .orderBy(desc(priceBooks.version))
      .limit(1);
    const book = rows[0];
    if (!book) throw invalid("没有生效中的价格表，请先在套餐与价格中启用");
    return book;
  }

  private async priceFor(bookId: string, planCode: string) {
    const rows = await this.db
      .select()
      .from(planPrices)
      .where(and(eq(planPrices.priceBookId, bookId), eq(planPrices.planCode, planCode)))
      .limit(1);
    const price = rows[0];
    if (!price) throw invalid(`价格表缺少套餐 ${planCode} 的价格`);
    return price;
  }

  private assertSeats(plan: PlanRow, seats: number): void {
    if (seats < plan.seatMin) throw invalid(`${plan.name} 至少 ${plan.seatMin} 个席位`);
    if (plan.seatMax !== null && seats > plan.seatMax) {
      throw invalid(`${plan.name} 最多 ${plan.seatMax} 个席位`);
    }
  }

  private async monthUsage(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ tenantId: usageDaily.tenantId, total: sum(usageDaily.agentActions) })
      .from(usageDaily)
      .where(gte(usageDaily.day, `${currentMonthPeriod()}-01`))
      .groupBy(usageDaily.tenantId);
    return new Map(rows.map((row) => [row.tenantId, Number(row.total ?? 0)]));
  }

  private async usageDays(tenantId: string, days: number): Promise<UsageDay[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select()
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.tenantId, tenantId),
          gte(usageDaily.day, since.toISOString().slice(0, 10)),
          lte(usageDaily.day, new Date().toISOString().slice(0, 10)),
        ),
      )
      .orderBy(usageDaily.day);
    return rows.map((row) => ({
      day: row.day,
      agentActions: row.agentActions,
      storageGb: Number(row.storageGb),
      smsCount: row.smsCount,
      llmInputTokens: row.llmInputTokens,
      llmOutputTokens: row.llmOutputTokens,
      llmCostCents: row.llmCostCents,
    }));
  }

  private mapSummary(
    tenant: TenantRow,
    subscription: SubscriptionRow | null,
    plan: PlanRow | null,
    usedActions: number,
  ): TenantSummary {
    return TenantSummary.parse({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      isolationMode: tenant.isolationMode,
      region: tenant.region,
      currency: tenant.currency,
      healthScore: tenant.healthScore,
      planCode: subscription?.planCode ?? null,
      seats: subscription?.seats ?? 0,
      billingCycle: subscription?.billingCycle ?? null,
      effectiveMonthlyCents: subscription?.effectiveMonthlyCents ?? 0,
      agentActionsUsed: usedActions,
      agentActionsQuota: plan?.agentActionsQuota ?? 0,
      nextDueAt: toIso(subscription?.nextDueAt),
      createdAt: tenant.createdAt.toISOString(),
    });
  }

  mapSubscription(row: SubscriptionRow): Subscription {
    return {
      id: row.id,
      tenantId: row.tenantId,
      planCode: row.planCode,
      priceBookId: row.priceBookId,
      seats: row.seats,
      billingCycle: row.billingCycle,
      status: row.status,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      trialEndsAt: toIso(row.trialEndsAt),
      nextDueAt: toIso(row.nextDueAt),
      effectiveMonthlyCents: row.effectiveMonthlyCents,
      overrideId: row.overrideId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  mapPlan(row: PlanRow): Plan {
    return {
      code: row.code,
      name: row.name,
      tier: row.tier,
      seatMin: row.seatMin,
      seatMax: row.seatMax,
      agentActionsQuota: row.agentActionsQuota,
      storageGb: row.storageGb,
      features: row.features,
      status: row.status,
    };
  }

  mapOverride(row: typeof tenantPriceOverrides.$inferSelect): TenantPriceOverride {
    return {
      id: row.id,
      tenantId: row.tenantId,
      planCode: row.planCode,
      monthlyPriceCents: row.monthlyPriceCents,
      seats: row.seats,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: toIso(row.effectiveTo),
      reason: row.reason,
      status: row.status,
      createdBy: row.createdBy,
      approvedBy: row.approvedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
