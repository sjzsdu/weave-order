import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  PriceBookDetail,
  PriceBookInput,
  PricingPreview,
  PricingPreviewInput,
} from "@weave-order/schema";
import type { Plan, PriceBook } from "@weave-order/schema";
import {
  plans,
  planPrices,
  priceBooks,
  subscriptions,
  tenantPriceOverrides,
  tenants,
} from "@weave-order/control-db";
import { PLATFORM_DATABASE } from "../db/database.provider";
import type { PlatformDb } from "../db/database.provider";
import type { PlatformActor } from "../auth/auth.service";
import { conflict, invalid, notFound } from "../domain/errors";
import { AuditService } from "./audit.service";
import { toIso } from "./util";

@Injectable()
export class PricingService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: PlatformDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listPlans(): Promise<Plan[]> {
    const rows = await this.db.select().from(plans).orderBy(plans.tier);
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      tier: row.tier,
      seatMin: row.seatMin,
      seatMax: row.seatMax,
      agentActionsQuota: row.agentActionsQuota,
      storageGb: row.storageGb,
      features: row.features,
      status: row.status,
    }));
  }

  async listBooks(): Promise<PriceBook[]> {
    const rows = await this.db.select().from(priceBooks).orderBy(desc(priceBooks.version));
    return rows.map((row) => this.mapBook(row));
  }

  async getBook(id: string): Promise<PriceBookDetail> {
    const rows = await this.db.select().from(priceBooks).where(eq(priceBooks.id, id)).limit(1);
    const book = rows[0];
    if (!book) throw notFound("价格表版本不存在");
    const prices = await this.db.select().from(planPrices).where(eq(planPrices.priceBookId, id));
    return PriceBookDetail.parse({
      book: this.mapBook(book),
      prices: prices.map((price) => ({
        planCode: price.planCode,
        monthlyPriceCents: price.monthlyPriceCents,
        annualPriceCents: price.annualPriceCents,
        currency: price.currency,
      })),
    });
  }

  /** 新建价格版本永远先落 DRAFT；生效必须走 owner+finance 双人复核。 */
  async createBook(actor: PlatformActor, raw: unknown): Promise<PriceBookDetail> {
    const input = PriceBookInput.parse(raw);
    const codes = await this.db.select({ code: plans.code }).from(plans);
    const known = new Set(codes.map((row) => row.code));
    for (const price of input.prices) {
      if (!known.has(price.planCode)) throw invalid(`套餐不存在：${price.planCode}`);
    }

    const latest = await this.db
      .select({ version: priceBooks.version })
      .from(priceBooks)
      .orderBy(desc(priceBooks.version))
      .limit(1);
    const version = (latest[0]?.version ?? 0) + 1;

    const created = await this.db.transaction(async (tx) => {
      const books = await tx
        .insert(priceBooks)
        .values({
          version,
          status: "DRAFT",
          notes: input.notes ?? null,
          createdBy: actor.sub,
        })
        .returning();
      const book = books[0];
      if (!book) throw new Error("价格表创建失败");
      await tx.insert(planPrices).values(
        input.prices.map((price) => ({
          priceBookId: book.id,
          planCode: price.planCode,
          monthlyPriceCents: price.monthlyPriceCents,
          annualPriceCents: price.annualPriceCents,
          currency: price.currency,
        })),
      );
      return book;
    });

    await this.audit.record(actor, {
      action: "PRICE_BOOK_DRAFTED",
      targetType: "price_book",
      targetId: created.id,
      after: { version, prices: input.prices },
      reason: "新建价格表草稿",
    });
    return this.getBook(created.id);
  }

  /**
   * 改价影响试算：改价前选真实租户预览「下个月会付多少」。
   * 返回逐租户差额与受影响数量，供审批人判断。
   */
  async impact(id: string): Promise<{
    book: PriceBook;
    affectedTenants: number;
    monthlyDeltaCents: number;
    rows: {
      tenantId: string;
      tenantName: string;
      planCode: string;
      seats: number;
      currentMonthlyCents: number;
      nextMonthlyCents: number;
      deltaCents: number;
    }[];
  }> {
    const detail = await this.getBook(id);
    const nextByPlan = new Map(detail.prices.map((price) => [price.planCode, price]));
    const active = await this.db
      .select()
      .from(priceBooks)
      .where(and(eq(priceBooks.status, "ACTIVE"), eq(priceBooks.id, id)))
      .limit(1);
    if (active[0]?.id === id) throw invalid("该版本已是生效版本");

    const rows = await this.db
      .select({ tenant: tenants, subscription: subscriptions })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId));

    const result = rows
      .filter((row) => nextByPlan.has(row.subscription.planCode))
      .map((row) => {
        const next = nextByPlan.get(row.subscription.planCode);
        if (!next) return null;
        const nextMonthly =
          row.subscription.billingCycle === "ANNUAL"
            ? Math.round(next.annualPriceCents / 12) * row.subscription.seats
            : next.monthlyPriceCents * row.subscription.seats;
        const currentMonthly = row.subscription.effectiveMonthlyCents * row.subscription.seats;
        return {
          tenantId: row.tenant.id,
          tenantName: row.tenant.name,
          planCode: row.subscription.planCode,
          seats: row.subscription.seats,
          currentMonthlyCents: currentMonthly,
          nextMonthlyCents: nextMonthly,
          deltaCents: nextMonthly - currentMonthly,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    return {
      book: detail.book,
      affectedTenants: result.length,
      monthlyDeltaCents: result.reduce((sum, row) => sum + row.deltaCents, 0),
      rows: result,
    };
  }

  /** 由审批执行器调用；直接调用会绕过双人复核，因此只在 ActionExecutor 内使用。 */
  async activateBook(actor: PlatformActor, id: string, reason: string): Promise<PriceBook> {
    const rows = await this.db.select().from(priceBooks).where(eq(priceBooks.id, id)).limit(1);
    const book = rows[0];
    if (!book) throw notFound("价格表版本不存在");
    if (book.status === "ACTIVE") throw conflict("该版本已经生效");

    const previous = await this.db.select().from(priceBooks).where(eq(priceBooks.status, "ACTIVE"));
    const now = new Date();
    const updated = await this.db.transaction(async (tx) => {
      for (const old of previous) {
        await tx.update(priceBooks).set({ status: "RETIRED" }).where(eq(priceBooks.id, old.id));
      }
      const changed = await tx
        .update(priceBooks)
        .set({ status: "ACTIVE", effectiveFrom: now, activatedAt: now })
        .where(eq(priceBooks.id, id))
        .returning();
      return changed[0];
    });
    if (!updated) throw new Error("价格表生效失败");

    await this.audit.record(actor, {
      action: "PRICE_BOOK_ACTIVATED",
      targetType: "price_book",
      targetId: id,
      before: { activeVersion: previous[0]?.version ?? null },
      after: { activeVersion: updated.version },
      reason,
    });
    return this.mapBook(updated);
  }

  /** 租户合同价：由审批执行器调用（双人复核通过后）。 */
  async createOverride(
    actor: PlatformActor,
    input: {
      tenantId: string;
      planCode: string;
      monthlyPriceCents: number;
      seats: number | null;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      reason: string;
    },
  ): Promise<string> {
    const existing = await this.db
      .select({ id: tenantPriceOverrides.id })
      .from(tenantPriceOverrides)
      .where(
        and(
          eq(tenantPriceOverrides.tenantId, input.tenantId),
          eq(tenantPriceOverrides.planCode, input.planCode),
          eq(tenantPriceOverrides.status, "ACTIVE"),
        ),
      );
    const created = await this.db.transaction(async (tx) => {
      for (const row of existing) {
        await tx
          .update(tenantPriceOverrides)
          .set({ status: "REVOKED" })
          .where(eq(tenantPriceOverrides.id, row.id));
      }
      const rows = await tx
        .insert(tenantPriceOverrides)
        .values({
          tenantId: input.tenantId,
          planCode: input.planCode,
          monthlyPriceCents: input.monthlyPriceCents,
          seats: input.seats,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          reason: input.reason,
          status: "ACTIVE",
          createdBy: actor.sub,
          approvedBy: actor.sub,
        })
        .returning();
      return rows[0];
    });
    if (!created) throw new Error("合同价创建失败");

    await this.audit.record(actor, {
      action: "TENANT_PRICE_OVERRIDE",
      targetType: "tenant",
      targetId: input.tenantId,
      after: {
        planCode: input.planCode,
        monthlyPriceCents: input.monthlyPriceCents,
        reason: input.reason,
        approvedBy: actor.sub,
      },
      reason: input.reason,
    });
    return created.id;
  }

  async preview(raw: unknown): Promise<PricingPreview> {
    const input = PricingPreviewInput.parse(raw);
    const plan = await this.db.select().from(plans).where(eq(plans.code, input.planCode)).limit(1);
    if (!plan[0]) throw notFound(`套餐不存在：${input.planCode}`);
    const book = await this.db
      .select()
      .from(priceBooks)
      .where(eq(priceBooks.status, "ACTIVE"))
      .orderBy(desc(priceBooks.version))
      .limit(1);
    let monthly = input.monthlyPriceCents;
    let annual = 0;
    if (book[0]) {
      const price = await this.db
        .select()
        .from(planPrices)
        .where(and(eq(planPrices.priceBookId, book[0].id), eq(planPrices.planCode, input.planCode)))
        .limit(1);
      if (price[0]) {
        monthly = monthly ?? price[0].monthlyPriceCents;
        annual = price[0].annualPriceCents;
      }
    }
    if (monthly === undefined) throw invalid("没有生效价格，请先启用价格表或显式传价格");
    const cyclePrice = {
      monthlyPriceCents: monthly,
      annualPriceCents: annual || monthly * 10,
    };
    return {
      planCode: input.planCode,
      seats: input.seats,
      billingCycle: input.billingCycle,
      monthlyPriceCents: monthly,
      monthlyTotalCents: monthly * input.seats,
      annualTotalCents: cyclePrice.annualPriceCents * input.seats,
      effectiveMonthlyCents:
        input.billingCycle === "ANNUAL"
          ? Math.round(cyclePrice.annualPriceCents / 12) * input.seats
          : monthly * input.seats,
    };
  }

  async listOverrides(tenantId?: string) {
    const rows = await this.db
      .select()
      .from(tenantPriceOverrides)
      .where(tenantId ? eq(tenantPriceOverrides.tenantId, tenantId) : undefined)
      .orderBy(desc(tenantPriceOverrides.createdAt));
    return rows.map((row) => ({
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
    }));
  }

  private mapBook(row: typeof priceBooks.$inferSelect): PriceBook {
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      effectiveFrom: row.effectiveFrom.toISOString(),
      notes: row.notes,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      activatedAt: toIso(row.activatedAt),
    };
  }

  /** 只给审批执行器用：查当前生效版本。 */
  async activeBookId(): Promise<string> {
    const rows = await this.db
      .select({ id: priceBooks.id })
      .from(priceBooks)
      .where(eq(priceBooks.status, "ACTIVE"))
      .orderBy(desc(priceBooks.version))
      .limit(1);
    if (!rows[0]) throw invalid("没有生效中的价格表");
    return rows[0].id;
  }
}
