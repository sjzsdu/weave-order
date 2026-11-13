import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  decisionDeltas,
  draftRevisions,
  openTenantSession,
  pricingPolicies,
  revisionRequests,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * Track A 验收：报价全链路 + 定价继承 + 审批升级。
 *
 * 一个人做一次具体动作：
 * 建客户 → 建样品 → 出报价草稿 → 改一个价 → 改幅超阈值自动升级审批
 * → 低层级批准被拒 → 主管批准 → confirm。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const APP_URL =
  process.env.APP_DATABASE_URL ?? "postgres://weave_app:weave_app@localhost:5433/weave_order";

const HUMAN_OWNER: KernelContext = {
  actor: { type: "HUMAN", id: "track-a-owner", role: "OWNER" },
};
const HUMAN_MANAGER: KernelContext = {
  actor: { type: "HUMAN", id: "track-a-manager", role: "MANAGER" },
};
const HUMAN_SALES: KernelContext = {
  actor: { type: "HUMAN", id: "track-a-sales", role: "SALES" },
};
const AGENT: KernelContext = { actor: { type: "AGENT", id: "track-a-agent" } };
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "track-a-bootstrap" } };

let probe: Pool | null = null;
let available = false;
let db: Db | null = null;

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.pricing_policies') IS NOT NULL AS exists",
    );
    available = table.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  } finally {
    await probe.end();
    probe = null;
  }
});

afterAll(async () => {
  await probe?.end();
});

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 每个用例独立租户：定价策略/客户/报价互不污染。 */
async function tenantKernel(id: string): Promise<Kernel> {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `ta-${id}`, name: `Track A ${id}`, casdoorOrg: `ta-${id}` },
    SYSTEM,
  );
  return createKernel(db, undefined, { tenantId: tenant.id });
}

describe("Track A：定价继承与管控夹取", () => {
  it("生效值 + 来源：下级只能收紧不能放宽", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `TA-PC-${id}`, name: "定价继承客户" },
      HUMAN_OWNER,
    );

    await kernel.pricing.create(
      {
        scopeType: "COMPANY",
        key: "pricing.min_margin_pct",
        value: 10,
        locked: true,
        priority: 10,
      },
      HUMAN_OWNER,
    );
    await kernel.pricing.create(
      {
        scopeType: "CUSTOMER",
        scopeId: customer.id,
        key: "pricing.min_margin_pct",
        value: 2,
        locked: false,
      },
      HUMAN_OWNER,
    );

    const resolved = await kernel.pricing.resolve("pricing.min_margin_pct", {
      customerId: customer.id,
    });
    // 客户层想放宽到 2%，被公司管控层夹回 10%。
    expect(resolved.value).toBe(10);
    expect(resolved.clamped).toBe(true);
    expect(resolved.source.scopeType).toBe("COMPANY");
    expect(resolved.source.locked).toBe(true);
    expect(resolved.chain.length).toBeGreaterThanOrEqual(2);

    // 客户层收紧到 15% 则应生效（只能收紧不能放宽）。
    await kernel.pricing.create(
      {
        scopeType: "CUSTOMER",
        scopeId: customer.id,
        key: "pricing.cost_floor_amount",
        value: 900,
        locked: true,
      },
      HUMAN_OWNER,
    );
    const floor = await kernel.pricing.resolve("pricing.cost_floor_amount", {
      customerId: customer.id,
    });
    expect(floor.value).toBe(900);
    expect(floor.source.scopeType).toBe("CUSTOMER");

    const rows = await db!.select().from(pricingPolicies);
    expect(rows.length).toBeGreaterThan(0);
  }, 20_000);

  it("夹取后保留对象形态与单位，不把百分比降级成裸数字", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `TA-SHAPE-${id}`, name: "形态测试客户" },
      HUMAN_OWNER,
    );
    await kernel.pricing.create(
      {
        scopeType: "COMPANY",
        key: "pricing.min_margin_pct",
        value: { marginPct: 10, unit: "percent" },
        locked: true,
      },
      HUMAN_OWNER,
    );
    await kernel.pricing.create(
      {
        scopeType: "CUSTOMER",
        scopeId: customer.id,
        key: "pricing.min_margin_pct",
        value: { marginPct: 2, unit: "percent" },
        locked: false,
      },
      HUMAN_OWNER,
    );

    const resolved = await kernel.pricing.resolve("pricing.min_margin_pct", {
      customerId: customer.id,
    });
    expect(resolved.clamped).toBe(true);
    expect(resolved.value).toEqual({ marginPct: 10, unit: "percent" });
  }, 20_000);
});

describe("Track A：报价全链路（建客户 → 草稿 → 改价 → 升级 → 批准 → confirm）", () => {
  it("改幅超阈值自动升级审批，低层级批准被拒，主管批准后落 SENT", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `TA-C-${id}`, name: "青禾服饰" },
      HUMAN_OWNER,
    );
    const sample = await kernel.samples.create(
      {
        code: `TA-S-${id}`,
        name: "40S 精梳棉",
        category: "cotton",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
      HUMAN_OWNER,
    );

    // 公司管控：最低毛利 10%，改幅 5% 以上升级经理。
    await kernel.pricing.create(
      {
        scopeType: "COMPANY",
        key: "pricing.min_margin_pct",
        value: 10,
        locked: true,
        priority: 10,
      },
      HUMAN_OWNER,
    );
    await kernel.pricing.create(
      {
        scopeType: "COMPANY",
        key: "pricing.reprice_escalation_pct",
        value: 5,
        priority: 10,
      },
      HUMAN_OWNER,
    );

    const draft = await kernel.quotes.generateDraft(
      {
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 100, unit: "meter" },
            unitPrice: { amount: 1500, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
    expect(draft.status).toBe("DRAFT");
    expect(draft.version).toBe(1);
    expect(draft.total.amount).toBe(150_000);
    expect(draft.approvalRequirement?.level).toBe("SALES");
    expect(draft.items[0]?.provenance).toBeTruthy();

    // 智能体不能直接改账本（G10）。
    await expect(
      kernel.quotes.reviseDraft(
        {
          quoteId: draft.id,
          baseVersion: 1,
          source: "INLINE",
          instruction: "改单价",
          lines: [{ lineIndex: 0, unitPrice: { amount: 1600, currency: "CNY" } }],
        },
        AGENT,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    // 低于成本底线：内核拒绝（即使有改幅理由）。
    await expect(
      kernel.quotes.reviseDraft(
        {
          quoteId: draft.id,
          baseVersion: 1,
          source: "INLINE",
          instruction: "降价",
          lines: [{ lineIndex: 0, unitPrice: { amount: 1000, currency: "CNY" } }],
        },
        HUMAN_OWNER,
      ),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "PRICE_BELOW_COST_FLOOR" },
    });

    // 改一个价：1500 → 1600，改幅 6.67% > 5%，自动升级 MANAGER。
    const revised = await kernel.quotes.reviseDraft(
      {
        quoteId: draft.id,
        baseVersion: 1,
        source: "INLINE",
        instruction: "客户嫌价格低，单价改 16.00",
        lines: [{ lineIndex: 0, unitPrice: { amount: 1600, currency: "CNY" } }],
      },
      HUMAN_OWNER,
    );
    expect(revised.draft.version).toBe(2);
    expect(revised.draft.total.amount).toBe(160_000);
    expect(revised.requirement.level).toBe("MANAGER");
    expect(revised.requirement.escalated).toBe(true);
    expect(revised.requirement.reasons).toContain("REPRICE_PCT_EXCEEDED");
    expect(revised.diff.some((entry) => entry.field.includes("unitPrice"))).toBe(true);
    expect(revised.revision.version).toBe(2);

    // 版本冲突：仍拿 v1 改稿必须被拒。
    await expect(
      kernel.quotes.reviseDraft(
        {
          quoteId: draft.id,
          baseVersion: 1,
          source: "INLINE",
          instruction: "再改一次",
          lines: [{ lineIndex: 0, unitPrice: { amount: 1700, currency: "CNY" } }],
        },
        HUMAN_OWNER,
      ),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "VERSION_CONFLICT" },
    });

    // 审批队列：requiredRole=MANAGER + 逐行 diff。
    const queue = await kernel.quotes.list(200);
    const item = queue.find((entry) => entry.id === draft.id);
    expect(item?.pending).toBe(true);
    expect(item?.requiredRole).toBe("MANAGER");
    expect(item?.escalated).toBe(true);
    expect(item?.diff?.length).toBeGreaterThan(0);

    // 业务员层级批准被内核拒绝。
    await expect(kernel.quotes.confirmDraft(draft.id, HUMAN_SALES)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    // 主管确认：DRAFT -> SENT，审计 HUMAN。
    const confirmed = await kernel.quotes.confirmDraft(draft.id, HUMAN_MANAGER);
    expect(confirmed.status).toBe("SENT");
    expect(confirmed.version).toBe(2);

    const view = await kernel.quotes.getApprovalView(draft.id);
    expect(view.status).toBe("SENT");
    expect(view.diff.length).toBeGreaterThan(0);
    expect(view.revisions.length).toBe(1);

    // 同事务落库：改稿版本、改稿请求、决策增量。
    const revisions = await db!.select().from(draftRevisions);
    expect(revisions.some((row) => row.entityId === draft.id && row.version === 2)).toBe(true);

    const requests = await db!.select().from(revisionRequests);
    expect(requests.some((row) => row.entityId === draft.id)).toBe(true);

    const deltas = await db!.select().from(decisionDeltas);
    const priceDelta = deltas.find(
      (row) => row.entityId === draft.id && row.field === "unit_price_0",
    );
    expect(priceDelta).toBeDefined();
    expect(priceDelta?.originalValue).toMatchObject({ amount: 1500 });
    expect(priceDelta?.modifiedValue).toMatchObject({ amount: 1600 });

    // 决策增量同时进入客户上下文（下次建议更快读到）。
    const context = await kernel.customers.getContext(customer.id);
    expect(context.decisionDeltas.some((delta) => delta.field === "unit_price_0")).toBe(true);

    // 审计同事务：改稿、升级、确认都由 HUMAN 落账。
    const audit = await kernel.audit.list(200);
    expect(
      audit.some(
        (entry) =>
          entry.action === "QUOTE_DRAFT_REVISED" &&
          entry.entityId === draft.id &&
          entry.actorType === "HUMAN",
      ),
    ).toBe(true);
    expect(
      audit.some(
        (entry) => entry.action === "QUOTE_APPROVAL_ESCALATED" && entry.entityId === draft.id,
      ),
    ).toBe(true);
    expect(
      audit.some(
        (entry) =>
          entry.action === "QUOTE_CONFIRMED" &&
          entry.entityId === draft.id &&
          entry.actorType === "HUMAN",
      ),
    ).toBe(true);
  }, 30_000);

  it("驳回：结构化原因进 decision_deltas", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `TA-RC-${id}`, name: "驳回客户" },
      HUMAN_OWNER,
    );
    const sample = await kernel.samples.create(
      {
        code: `TA-RS-${id}`,
        name: "驳回面料",
        unit: "meter",
        costFloor: { amount: 900, currency: "CNY" },
      },
      HUMAN_OWNER,
    );
    const reasons = await kernel.revisions.ensureDefaults(HUMAN_OWNER);
    const priceReason = reasons.find((reason) => reason.code === "PRICE");
    expect(priceReason).toBeDefined();

    const draft = await kernel.quotes.generateDraft(
      {
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 10, unit: "meter" },
            unitPrice: { amount: 1000, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );

    const rejected = await kernel.quotes.rejectDraft(
      draft.id,
      HUMAN_OWNER,
      "客户说太贵",
      priceReason?.id,
    );
    expect(rejected.status).toBe("REJECTED");

    const deltas = await kernel.customers.listDecisionDeltas(customer.id);
    const delta = deltas.find((entry) => entry.field === "quote_status");
    expect(delta?.modifiedValue).toBe("REJECTED");
    expect(delta?.reasonId).toBe(priceReason?.id);
  }, 20_000);
});

describe("Track A：订单 / 应收内核", () => {
  it("订单确认后建应收，部分收款 → 收满 → 超额拒绝", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `TA-OC-${id}`, name: "订单客户" },
      HUMAN_OWNER,
    );
    const sample = await kernel.samples.create(
      {
        code: `TA-OS-${id}`,
        name: "订单面料",
        unit: "meter",
        costFloor: { amount: 500, currency: "CNY" },
      },
      HUMAN_OWNER,
    );

    const order = await kernel.orders.create(
      {
        customerId: customer.id,
        code: `WO-${id}`,
        currency: "CNY",
        items: [
          {
            sampleId: sample.id,
            quantity: { value: 100, unit: "meter" },
            unitPrice: { amount: 1000, currency: "CNY" },
          },
        ],
      },
      HUMAN_OWNER,
    );
    expect(order.status).toBe("DRAFT");
    expect(order.total.amount).toBe(100_000);

    await expect(
      kernel.receivables.create(
        {
          orderId: order.id,
          amount: { amount: 100_000, currency: "CNY" },
          dueDate: "2026-12-31T00:00:00.000Z",
        },
        HUMAN_OWNER,
      ),
    ).rejects.toMatchObject({ code: "KERNEL_REJECTED" });

    const confirmedOrder = await kernel.orders.confirm(order.id, HUMAN_OWNER);
    expect(confirmedOrder.status).toBe("CONFIRMED");

    const receivable = await kernel.receivables.create(
      {
        orderId: order.id,
        amount: { amount: 100_000, currency: "CNY" },
        dueDate: "2026-12-31T00:00:00.000Z",
      },
      HUMAN_OWNER,
    );
    expect(receivable.status).toBe("PENDING");

    const partial = await kernel.receivables.recordPayment(
      {
        receivableId: receivable.id,
        amount: { amount: 60_000, currency: "CNY" },
      },
      HUMAN_OWNER,
    );
    expect(partial.status).toBe("PARTIAL");
    expect(partial.paidAmount.amount).toBe(60_000);

    await expect(
      kernel.receivables.recordPayment(
        {
          receivableId: receivable.id,
          amount: { amount: 50_000, currency: "CNY" },
        },
        HUMAN_OWNER,
      ),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "PAYMENT_EXCEEDS_REMAINING" },
    });

    const paid = await kernel.receivables.recordPayment(
      {
        receivableId: receivable.id,
        amount: { amount: 40_000, currency: "CNY" },
      },
      HUMAN_OWNER,
    );
    expect(paid.status).toBe("PAID");
    expect(paid.paidAt).not.toBeNull();
  }, 30_000);
});

describe("Track A：新增表的跨租户 RLS", () => {
  it("租户 B 看不到租户 A 的定价策略与决策增量", async (ctx) => {
    if (!available || !db) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const owner = createKernel(db);
    const tenantA = await owner.tenancy.createTenant(
      { slug: `ta-rls-a-${id}`, name: "RLS A", casdoorOrg: `ta-rls-a-${id}` },
      SYSTEM,
    );
    const tenantB = await owner.tenancy.createTenant(
      { slug: `ta-rls-b-${id}`, name: "RLS B", casdoorOrg: `ta-rls-b-${id}` },
      SYSTEM,
    );
    const appPool = new Pool({ connectionString: APP_URL, max: 2 });
    try {
      const sessionA = await openTenantSession(appPool, tenantA.id);
      const kernelA = createKernel(sessionA.db, undefined, { tenantId: tenantA.id });
      const customerA = await kernelA.customers.create(
        { code: `RLS-A-${id}`, name: "租户 A 客户" },
        HUMAN_OWNER,
      );
      await kernelA.pricing.create(
        {
          scopeType: "COMPANY",
          key: "pricing.min_margin_pct",
          value: 12,
          locked: true,
        },
        HUMAN_OWNER,
      );
      await kernelA.customers.listDecisionDeltas(customerA.id);
      await sessionA.release();

      const sessionB = await openTenantSession(appPool, tenantB.id);
      const kernelB = createKernel(sessionB.db, undefined, { tenantId: tenantB.id });
      expect(await kernelB.pricing.list()).toEqual([]);
      const resolved = await kernelB.pricing.resolve("pricing.min_margin_pct", {});
      expect(resolved.source.kind).toBe("SYSTEM_DEFAULT");
      await expect(kernelB.customers.getById(customerA.id)).rejects.toMatchObject({
        code: "CUSTOMER_NOT_FOUND",
      });
      await sessionB.release();
    } finally {
      await appPool.end();
    }
  }, 30_000);
});
