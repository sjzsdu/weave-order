import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformDb, resolvePlatformDatabaseUrl } from "@weave-order/control-db";
import type { PlatformDb } from "@weave-order/control-db";
import { plans, planPrices, priceBooks } from "@weave-order/control-db";
import type { PlatformActor } from "../src/auth/auth.service";
import { AccountExecutor } from "./helpers/actor";
import { ActionExecutorService } from "../src/control/action-executor.service";
import { ApprovalsService } from "../src/control/approvals.service";
import { AuditService } from "../src/control/audit.service";
import { BreakGlassService } from "../src/control/break-glass.service";
import { InvoicesService } from "../src/control/invoices.service";
import { PricingService } from "../src/control/pricing.service";
import { TenantsService } from "../src/control/tenants.service";
import { UsageService } from "../src/control/usage.service";
import { DEV_ONBOARDING_SECRET, verifyOnboardingTicket } from "../src/control/onboarding-ticket";
import { TrialSweepService } from "../src/control/trial-sweep.service";

/**
 * 控制面集成测试：需要本地 PostgreSQL + `pnpm platform:migrate`。
 * 没有控制面库时整组跳过，离线 `pnpm test` 仍然全绿。
 */
const URL = process.env.PLATFORM_DATABASE_URL ?? resolvePlatformDatabaseUrl();
let db: PlatformDb | null = null;
let pool: ReturnType<typeof createPlatformDb>["pool"] | null = null;
let available = false;

let tenants: TenantsService;
let pricing: PricingService;
let invoices: InvoicesService;
let usage: UsageService;
let approvals: ApprovalsService;
let breakGlass: BreakGlassService;
let audit: AuditService;

const owner: PlatformActor = AccountExecutor("e2e-owner", "platform_owner");
const secondOwner: PlatformActor = AccountExecutor("e2e-owner2", "platform_owner");
const finance: PlatformActor = AccountExecutor("e2e-finance", "platform_finance");

const suffix = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  try {
    const handle = createPlatformDb(URL);
    pool = handle.pool;
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('control.tenants') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (!available) {
      await pool.end();
      pool = null;
      return;
    }
    db = handle.db;

    audit = new AuditService(db);
    tenants = new TenantsService(db, audit);
    pricing = new PricingService(db, audit);
    invoices = new InvoicesService(db, audit);
    usage = new UsageService(db);
    breakGlass = new BreakGlassService(db, audit);
    const executor = new ActionExecutorService(tenants, pricing, invoices, breakGlass);
    approvals = new ApprovalsService(db, executor, audit);

    // 测试自带套餐与价格表，避免依赖 seed 顺序。
    for (const plan of [
      { code: `T${suffix()}`.toUpperCase(), name: "测试套餐", tier: 2, seatMin: 1, seatMax: 100 },
    ]) {
      await db
        .insert(plans)
        .values({ ...plan, agentActionsQuota: 5000, storageGb: 100, features: {} })
        .onConflictDoNothing();
    }
    const active = await db
      .select()
      .from(priceBooks)
      .where(sql`${priceBooks.status} = 'ACTIVE'`)
      .limit(1);
    if (!active[0]) {
      const rows = await db
        .insert(priceBooks)
        .values({ version: 9000, status: "ACTIVE", effectiveFrom: new Date(), createdBy: "test" })
        .returning();
      if (rows[0]) {
        await db.insert(planPrices).values({
          priceBookId: rows[0].id,
          planCode: "PRO",
          monthlyPriceCents: 49900,
          annualPriceCents: 499000,
        });
      }
    }
  } catch {
    available = false;
    await pool?.end();
    pool = null;
  }
});

afterAll(async () => {
  await pool?.end();
});

describe("平台控制面（集成）", () => {
  let tenantId = "";
  let invoiceId = "";

  it("开通公司 → 改套餐/席位", async (ctx) => {
    if (!available) ctx.skip();
    const created = await tenants.provision(owner, {
      name: `集成公司-${suffix()}`,
      slug: `it-${suffix()}`,
      planCode: "PRO",
      seats: 12,
      billingCycle: "MONTHLY",
      trialDays: 3,
      region: "cn-east",
    });
    tenantId = created.id;
    expect(created.status).toBe("TRIAL");
    expect(created.seats).toBe(12);
    expect(created.agentActionsQuota).toBe(5000);

    await tenants.applySubscription(owner, tenantId, {
      planCode: "PRO",
      seats: 12,
      billingCycle: "MONTHLY",
    });
    const detail = await tenants.get(tenantId);
    expect(detail.tenant.status).toBe("ACTIVE");
    expect(detail.subscription?.seats).toBe(12);
    expect(detail.subscription?.billingCycle).toBe("MONTHLY");
  });

  it("用量事件幂等，日聚合只计一次", async (ctx) => {
    if (!available) ctx.skip();
    const key = `it-action-${randomUUID()}`;
    const first = await usage.ingest({
      tenantId,
      kind: "agent_action",
      quantity: 12,
      idempotencyKey: key,
    });
    const replay = await usage.ingest({
      tenantId,
      kind: "agent_action",
      quantity: 12,
      idempotencyKey: key,
    });
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);

    const month = await usage.month(tenantId);
    expect(month.usage.reduce((sum, day) => sum + day.agentActions, 0)).toBe(12);
    expect(month.state).toBe("OK");
  });

  it("账单：价税分离、开具、回款", async (ctx) => {
    if (!available) ctx.skip();
    const invoice = await invoices.create(owner, {
      tenantId,
      periodStart: "2026-11-01T00:00:00.000Z",
      periodEnd: "2026-11-30T23:59:59.000Z",
      adjustments: [],
    });
    invoiceId = invoice.id;
    expect(invoice.status).toBe("DRAFT");
    // 月付：49900 × 12 = 598,800 分；税 6% 四舍五入。
    expect(invoice.subtotalCents).toBe(598_800);
    expect(invoice.taxCents).toBe(Math.round((598_800 * 600) / 10_000));
    expect(invoice.totalCents).toBe(invoice.subtotalCents + invoice.taxCents);

    const issued = await invoices.issue(owner, invoiceId, {});
    expect(issued.status).toBe("ISSUED");
    const paid = await invoices.markPaid(owner, invoiceId, {});
    expect(paid.status).toBe("PAID");
    expect(paid.paidAt).not.toBeNull();
  });

  it("退款：owner + finance 双人复核，金额不得超过可退余额", async (ctx) => {
    if (!available) ctx.skip();
    const approval = await approvals.create(owner, {
      action: "REFUND",
      targetType: "invoice",
      targetId: invoiceId,
      summary: "集成测试退款",
      payload: { invoiceId, amountCents: 10_000, reason: "客户部分退款" },
      reason: "客户部分退款",
    });
    const executed = await approvals.decide(finance, approval.id, {
      decision: "approve",
      reason: "同意退款",
    });
    expect(executed.status).toBe("EXECUTED");

    const list = await invoices.listRefunds(invoiceId);
    expect(list).toHaveLength(1);
    expect(list[0]?.amountCents).toBe(10_000);
    expect(list[0]?.status).toBe("APPROVED");

    await expect(invoices.applyRefund(owner, invoiceId, 10_000_000, "超退")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("暂停 / 恢复：状态与审计同步", async (ctx) => {
    if (!available) ctx.skip();
    const suspended = await tenants.setStatus(owner, tenantId, {
      status: "SUSPENDED",
      reason: "集成测试暂停",
    });
    expect(suspended.status).toBe("SUSPENDED");
    const resumed = await tenants.setStatus(owner, tenantId, {
      status: "ACTIVE",
      reason: "集成测试恢复",
    });
    expect(resumed.status).toBe("ACTIVE");

    const entries = await audit.list(20, { targetId: tenantId });
    expect(entries.some((entry) => entry.action === "TENANT_SUSPENDED")).toBe(true);
    expect(entries.some((entry) => entry.action === "TENANT_ACTIVE")).toBe(true);
  });

  it("强制改套餐：发起人不能自批，第二 owner 批准后才执行", async (ctx) => {
    if (!available) ctx.skip();
    const approval = await approvals.create(owner, {
      action: "TENANT_FORCE_PLAN",
      targetType: "tenant",
      targetId: tenantId,
      summary: "集成测试合同价",
      payload: {
        tenantId,
        input: { planCode: "PRO", seats: 12, billingCycle: "MONTHLY" },
        monthlyPriceCents: 44900,
        reason: "集成测试锁价",
      },
      reason: "集成测试锁价",
    });

    await expect(
      approvals.decide(owner, approval.id, { decision: "approve" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      approvals.decide(finance, approval.id, { decision: "approve" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const executed = await approvals.decide(secondOwner, approval.id, {
      decision: "approve",
      reason: "同意",
    });
    expect(executed.status).toBe("EXECUTED");

    const detail = await tenants.get(tenantId);
    expect(detail.subscription?.effectiveMonthlyCents).toBe(44900);
    expect(detail.overrides[0]?.monthlyPriceCents).toBe(44900);
    expect(detail.overrides[0]?.status).toBe("ACTIVE");
  });

  it("break-glass：无租户同意拒绝；批准后 ≤60 分钟只读且只留审计", async (ctx) => {
    if (!available) ctx.skip();
    await expect(
      breakGlass.create(owner, {
        tenantId,
        ticketNo: "IT-001",
        reason: "核对单据",
        tenantConsent: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const request = await breakGlass.create(owner, {
      tenantId,
      ticketNo: "IT-002",
      reason: "核对单据",
      tenantConsent: true,
    });
    const approval = await approvals.create(owner, {
      action: "BREAK_GLASS",
      targetType: "break_glass",
      targetId: request.id,
      summary: "集成测试 break-glass",
      payload: { breakGlassId: request.id },
      reason: "租户已同意",
    });
    const approved = await approvals.decide(secondOwner, approval.id, { decision: "approve" });
    expect(approved.status).toBe("EXECUTED");

    const grant = await breakGlass.get(request.id);
    expect(grant.status).toBe("ACTIVE");
    expect(grant.expiresAt).not.toBeNull();
    const minutes = (new Date(grant.expiresAt as string).getTime() - Date.now()) / 60000;
    expect(minutes).toBeLessThanOrEqual(60.1);

    const access = await breakGlass.recordAccess(owner, request.id, "quote-detail");
    expect(access.granted).toBe(true);
    expect(access.readOnly).toBe(true);
    expect(JSON.stringify(access)).not.toContain("customerName");

    // 过期后立即拒绝
    if (db) {
      await db.execute(
        sql`update control.break_glass_requests set expires_at = now() - interval '1 minute' where id = ${request.id}`,
      );
    }
    await expect(breakGlass.recordAccess(owner, request.id, "quote-detail")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("平台审计只追加（数据库触发器拒绝 UPDATE/DELETE）", async (ctx) => {
    const connection = pool;
    if (!available || !connection) {
      ctx.skip();
      return;
    }
    await expect(
      connection.query("update control.platform_audit set reason = 'tampered'"),
    ).rejects.toThrow(/只允许追加/);
    await expect(connection.query("delete from control.platform_audit")).rejects.toThrow(
      /只允许追加/,
    );
  });

  it("控制面库里不存在任何租户业务表", async (ctx) => {
    const connection = pool;
    if (!available || !connection) {
      ctx.skip();
      return;
    }
    const result = await connection.query<{ name: string | null }>(
      "SELECT to_regclass('public.customers') AS name",
    );
    expect(result.rows[0]?.name).toBeNull();
  });

  it("生成开通链接：指向 /activate、7 天有效、可被验签", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const created = await tenants.provision(owner, {
      name: `开通链接公司-${suffix()}`,
      slug: `onboard-${suffix()}`,
      planCode: "PRO",
      seats: 10,
      billingCycle: "MONTHLY",
      contactEmail: "boss@example.com",
      region: "cn-east",
    });
    const link = await tenants.onboardingLink(owner, created.id);
    expect(link.url).toContain("/activate?code=");
    expect(link.ownerEmail).toBe("boss@example.com");
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);

    const ticket = verifyOnboardingTicket(link.code, DEV_ONBOARDING_SECRET);
    expect(ticket).toMatchObject({ slug: created.slug, ownerEmail: "boss@example.com" });
  });
});

describe("试用到期任务（集成）", () => {
  it("提前一天提醒一次；到期转只读", async (ctx) => {
    if (!available || !db) {
      ctx.skip();
      return;
    }
    const sweep = new TrialSweepService(db, audit);

    // 造一间 12 小时后到期的试用租户。
    const ending = await tenants.provision(owner, {
      name: `即将到期-${suffix()}`,
      slug: `sweep-${suffix()}`,
      planCode: "PRO",
      seats: 10,
      billingCycle: "MONTHLY",
      trialDays: 3,
      contactEmail: "boss@example.com",
      region: "cn-east",
    });
    const now = new Date();
    const soon = new Date(now.getTime() + 12 * 3600 * 1000);
    const connection = pool;
    if (!connection) {
      ctx.skip();
      return;
    }
    await connection.query(
      "UPDATE control.subscriptions SET trial_ends_at = $1 WHERE tenant_id = $2",
      [soon, ending.id],
    );

    const first = await sweep.run(now);
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    // 两小时内重跑不会重复提醒。
    const second = await sweep.run(now);
    expect(second.reminded).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);

    // 到期后：租户与订阅都转 SUSPENDED。
    const past = new Date(now.getTime() - 3600 * 1000);
    await connection.query(
      "UPDATE control.subscriptions SET trial_ends_at = $1 WHERE tenant_id = $2",
      [past, ending.id],
    );
    const expired = await sweep.run(now);
    expect(expired.suspended).toBeGreaterThanOrEqual(1);

    const tenantRow = await connection.query<{ status: string }>(
      "SELECT status FROM control.tenants WHERE id = $1",
      [ending.id],
    );
    expect(tenantRow.rows[0]?.status).toBe("SUSPENDED");
    const subRow = await connection.query<{ status: string }>(
      "SELECT status FROM control.subscriptions WHERE tenant_id = $1",
      [ending.id],
    );
    expect(subRow.rows[0]?.status).toBe("SUSPENDED");
  });
});
