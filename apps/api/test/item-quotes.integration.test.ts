import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, quoteItems, quotes, items as itemsTable } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel, isKernelError } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import { LocalStubEmbeddingProvider } from "../src/platform/embedding";

/**
 * P0a-5 报价闭环（旅程 A）：需要真实 PG。
 *
 * 覆盖验收里的硬约束：
 * - 报价真的挂在事项上，`complete` 按 itemId 校验，不误判同客户同样品的另一条事项；
 * - 确认幂等键重放返回同一结果且只有一条确认审计；
 * - 未授权角色确认被拒；
 * - 改价保留原价，依据仍能给出成本/毛利/历史成交；
 * - 复制文本含编号/客户/样品/数量/单价/合计/有效期。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "p0a5-bootstrap" } };
const OWNER: KernelContext = { actor: { type: "HUMAN", id: "p0a5-owner", role: "OWNER" } };
const SALES: KernelContext = { actor: { type: "HUMAN", id: "p0a5-sales", role: "SALES" } };

let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.items') IS NOT NULL AND to_regclass('public.quotes') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (pool && available && createdTenants.length > 0) {
    await pool.query("DELETE FROM quote_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM quotes WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM customer_contacts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

async function isolatedTenant(id: string) {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `p0a5-${id}-${suffix()}`, name: `P0a5 ${id}`, casdoorOrg: `p0a5-${id}` },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  const kernel = createKernel(db, new LocalStubEmbeddingProvider(), { tenantId: tenant.id });
  return { tenant, kernel };
}

async function seedJourney(kernel: Kernel) {
  const customer = await kernel.customers.create(
    { code: `C-J-${suffix()}`, name: "旅程客户" },
    OWNER,
  );
  const sample = await kernel.samples.create(
    {
      code: `S-J-${suffix()}`,
      name: "旅程面料",
      unit: "meter",
      costFloor: { amount: 1200, currency: "CNY" },
    },
    OWNER,
  );
  const first = await kernel.items.create(
    { customerId: customer.id, sampleId: sample.id, quantity: { value: 100, unit: "meter" } },
    OWNER,
  );
  const second = await kernel.items.create(
    { customerId: customer.id, sampleId: sample.id, quantity: { value: 200, unit: "meter" } },
    OWNER,
  );
  return { customer, sample, firstItemId: first.item!.id, secondItemId: second.item!.id };
}

describe("P0a-5 报价闭环", () => {
  it("报价确认人展示姓名，不把 subject UUID 抛给前端", async (ctx) => {
    if (!available) ctx.skip();
    const { tenant, kernel } = await isolatedTenant("confirmer-name");
    await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: OWNER.actor.id,
        displayName: "王婷",
        role: "OWNER",
        dataScope: "ALL",
      },
      SYSTEM,
    );
    const { firstItemId } = await seedJourney(kernel);
    const draft = await kernel.quotes.createForItem(firstItemId, {}, OWNER);
    await kernel.quotes.confirmDraft(draft.draft.id, OWNER, draft.version, "confirmer-name-1");

    const detail = await kernel.quotes.get(draft.draft.id);
    expect(detail.confirmedBy).toBe(OWNER.actor.id);
    expect(detail.confirmedByName).toBe("王婷");

    const list = await kernel.quotes.listForItem(firstItemId);
    expect(list.quotes[0]?.confirmedByName).toBe("王婷");
  });

  it("报价挂 itemId；确认幂等；完成按 itemId 而不误判同客户同样品的另一条事项", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("journey");
    const { firstItemId, secondItemId } = await seedJourney(kernel);

    const draft = await kernel.quotes.createForItem(
      firstItemId,
      { unitPrice: { amount: 1800, currency: "CNY" }, validityDays: 14 },
      OWNER,
    );
    expect(draft.itemId).toBe(firstItemId);
    expect(draft.status).toBe("DRAFT");
    expect(draft.draft.items[0]?.unitPrice.amount).toBe(1800);
    expect(draft.quoteNumber).toMatch(/^BJ-\d{8}-/);

    // 业务员没有 quote.confirm：确认被拒。
    await expect(
      kernel.quotes.confirmDraft(draft.draft.id, SALES, draft.version, "sales-try-123"),
    ).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.code === "PERMISSION_DENIED",
    );

    const confirmed = await kernel.quotes.confirmDraft(
      draft.draft.id,
      OWNER,
      draft.version,
      "journey-confirm-1",
    );
    expect(confirmed.status).toBe("SENT");

    // 同一次点击的重试：同一结果，不新增审计。
    const replay = await kernel.quotes.confirmDraft(
      draft.draft.id,
      OWNER,
      draft.version,
      "journey-confirm-1",
    );
    expect(replay.confirmedAt).toBe(confirmed.confirmedAt);
    expect(replay.confirmedBy).toBe(confirmed.confirmedBy);
    const audits = await kernel.audit.list(200, draft.draft.id);
    expect(audits.filter((entry) => entry.action === "QUOTE_CONFIRMED")).toHaveLength(1);

    // 事项 A 可完成。
    const completed = await kernel.items.complete(firstItemId, OWNER);
    expect(completed.item.status).toBe("COMPLETED");

    // 事项 B 同客户同样品，但没有自己的报价：不能被 A 的报价「带完成」。
    await expect(kernel.items.complete(secondItemId, OWNER)).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.details.reason === "ITEM_RESULT_MISSING",
    );
  }, 30_000);

  it("改价保留原价与 baseline；依据给出成本/毛利/历史；复制文本字段齐全", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("revise");
    const { firstItemId } = await seedJourney(kernel);

    const draft = await kernel.quotes.createForItem(
      firstItemId,
      { unitPrice: { amount: 1800, currency: "CNY" } },
      OWNER,
    );
    const revised = await kernel.quotes.reviseForItem(
      draft.draft.id,
      {
        baseVersion: draft.version,
        lines: [{ lineIndex: 0, unitPrice: { amount: 2000, currency: "CNY" } }],
        note: "客户目标价",
      },
      OWNER,
    );
    expect(revised.changes[0]).toMatchObject({
      beforeUnitPrice: { amount: 1800 },
      afterUnitPrice: { amount: 2000 },
      delta: { amount: 200 },
    });

    const detail = await kernel.quotes.get(draft.draft.id);
    expect(detail.baselineTotal?.amount).toBe(180000);
    expect(detail.draft.total.amount).toBe(200000);
    expect(detail.pendingDiff.length).toBeGreaterThan(0);

    const basis = await kernel.quotes.basis(draft.draft.id);
    expect(basis.lines[0]?.sampleCostFloor.amount).toBe(1200);
    expect(basis.lines[0]?.unitPrice.amount).toBe(2000);
    expect(basis.lines[0]?.marginAmount.amount).toBe(800);
    expect(basis.history).toEqual([]);

    await kernel.quotes.confirmDraft(draft.draft.id, OWNER, revised.version, "revise-confirm-1");
    const copy = await kernel.quotes.copyText(draft.draft.id);
    expect(copy.quoteNumber).toMatch(/^BJ-\d{8}-/);
    expect(copy.customerName).toBe("旅程客户");
    expect(copy.quantityText).toContain("100");
    expect(copy.unitPriceText).toContain("20.00");
    expect(copy.totalText).toContain("2,000.00");
    expect(copy.text).toContain("有效期");

    // 再开一张报价后，依据里能看到历史成交来源单据。
    const next = await kernel.quotes.createForItem(
      firstItemId,
      { unitPrice: { amount: 2100, currency: "CNY" } },
      OWNER,
    );
    const nextBasis = await kernel.quotes.basis(next.draft.id);
    expect(nextBasis.history.length).toBeGreaterThan(0);
    expect(nextBasis.history[0]?.unitPrice.amount).toBe(2000);
    expect(nextBasis.lastDealUnitPrice?.amount).toBe(2000);
  }, 30_000);

  it("没有业务结果的事项 complete 返回明确错误", async (ctx) => {
    if (!available) ctx.skip();
    const { kernel } = await isolatedTenant("nobasis");
    const { firstItemId } = await seedJourney(kernel);
    await expect(kernel.items.complete(firstItemId, OWNER)).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.details.reason === "ITEM_RESULT_MISSING",
    );
  }, 20_000);

  it("旧报价没有 itemId 时仍按客户+样品兜底（迁移兼容）", async (ctx) => {
    if (!available) ctx.skip();
    const { tenant, kernel } = await isolatedTenant("legacy");
    const { customer, sample, firstItemId } = await seedJourney(kernel);
    const rows = await db!
      .insert(quotes)
      .values({
        tenantId: tenant.id,
        customerId: customer.id,
        status: "SENT",
        currency: "CNY",
        subtotalAmount: 150000,
        totalAmount: 150000,
        validityDays: 15,
        expiresAt: new Date(Date.now() + 15 * 86400_000),
      })
      .returning();
    await db!.insert(quoteItems).values({
      tenantId: tenant.id,
      quoteId: rows[0]!.id,
      sampleId: sample.id,
      position: 0,
      description: "历史报价",
      quantityMilli: 150000,
      unit: "meter",
      unitPriceAmount: 1000,
      lineTotalAmount: 150000,
    });
    const completed = await kernel.items.complete(firstItemId, OWNER);
    expect(completed.item.status).toBe("COMPLETED");
  }, 20_000);

  it("跨租户读不到别家事项的报价", async (ctx) => {
    if (!available) ctx.skip();
    const a = await isolatedTenant("iso-a");
    const b = await isolatedTenant("iso-b");
    const { firstItemId } = await seedJourney(a.kernel);
    const draft = await a.kernel.quotes.createForItem(
      firstItemId,
      { unitPrice: { amount: 1800, currency: "CNY" } },
      OWNER,
    );
    await expect(b.kernel.quotes.get(draft.draft.id)).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.code === "RESOURCE_NOT_FOUND",
    );
    await expect(b.kernel.quotes.listForItem(firstItemId)).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.code === "RESOURCE_NOT_FOUND",
    );
    // 直接核对写入行确实带 itemId（防止「只改了返回值」的假接线）。
    const rows = await db!.select().from(quotes).where(eq(quotes.tenantId, a.tenant.id));
    expect(rows.some((row) => row.itemId === firstItemId)).toBe(true);
    expect(
      await db!.select().from(itemsTable).where(eq(itemsTable.tenantId, a.tenant.id)),
    ).toHaveLength(2);
  }, 30_000);
});
