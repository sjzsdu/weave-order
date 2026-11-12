import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, openTenantSession } from "@weave-order/db";
import type { Db, TenantSession } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * T0 验收：租户上下文 + 最小内核链路 + 跨租户越权拦截。
 *
 * 必须使用**应用角色**（weave_app，NOSUPERUSER / NOBYPASSRLS）连接，
 * 否则 owner 会绕过 RLS，测试就失去意义。
 */
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const APP_URL =
  process.env.APP_DATABASE_URL ?? "postgres://weave_app:weave_app@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "t0-bootstrap" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "t0-owner" } };

let ownerPool: Pool | null = null;
let appPool: Pool | null = null;
let ownerDb: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  ownerPool = new Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 1500, max: 3 });
  appPool = new Pool({ connectionString: APP_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const table = await ownerPool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.tenants') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='weave_app') AS exists",
    );
    available = table.rows[0]?.exists === true;
    if (available) ownerDb = createDb(OWNER_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (ownerPool && available && createdTenants.length > 0) {
    await ownerPool.query("DELETE FROM quote_items WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM quotes WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await ownerPool.query("DELETE FROM sample_shipment_items WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM sample_shipments WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    // audit_log 只追加，触发器禁止 DELETE：测试数据保留在审计里（无 FK 指向租户）。
    await ownerPool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await ownerPool?.end();
  await appPool?.end();
});

async function bootstrapTenant(label: string): Promise<{ tenantId: string; subject: string }> {
  if (!ownerDb) throw new Error("数据库不可用");
  const kernel = createKernel(ownerDb);
  const tenant = await kernel.tenancy.createTenant(
    { slug: `t0-${label}-${suffix()}`, name: `T0 ${label}`, casdoorOrg: `org-${label}` },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  const subject = `${label}-${suffix()}`;
  await kernel.tenancy.createMembership(
    {
      tenantId: tenant.id,
      subject,
      casdoorOrg: `org-${label}`,
      role: "OWNER",
      dataScope: "ALL",
      approvalLimitAmount: 100_000_000,
    },
    SYSTEM,
  );
  return { tenantId: tenant.id, subject };
}

async function tenantKernel(tenantId: string): Promise<{
  session: TenantSession;
  kernel: ReturnType<typeof createKernel>;
}> {
  if (!appPool) throw new Error("应用连接池不可用");
  const session = await openTenantSession(appPool, tenantId);
  return {
    session,
    kernel: createKernel(session.db, undefined, { tenantId }),
  };
}

describe("T0 多租户地基（应用角色 + RLS）", () => {
  it("应用角色没有 BYPASSRLS", async (ctx) => {
    if (!available || !appPool) ctx.skip();
    const rows = await appPool!.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows.rows[0]?.rolsuper).toBe(false);
    expect(rows.rows[0]?.rolbypassrls).toBe(false);
  });

  it("建租户 → 建客户 → 出报价草稿，审计同事务落库", async (ctx) => {
    if (!available) ctx.skip();
    const { tenantId } = await bootstrapTenant("chain");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const customer = await kernel.customers.create(
        { code: `C-${suffix()}`, name: "T0 链路客户" },
        HUMAN,
      );
      expect(customer.tenantId).toBe(tenantId);

      const sample = await kernel.samples.create(
        {
          code: `S-${suffix()}`,
          name: "T0 链路面料",
          unit: "meter",
          costFloor: { amount: 1000, currency: "CNY" },
        },
        HUMAN,
      );
      expect(sample.tenantId).toBe(tenantId);

      const draft = await kernel.quotes.generateDraft(
        {
          customerId: customer.id,
          currency: "CNY",
          validityDays: 30,
          items: [
            {
              fabricSampleId: sample.id,
              quantity: { value: 10, unit: "meter" },
              unitPrice: { amount: 1500, currency: "CNY" },
            },
          ],
        },
        HUMAN,
      );

      expect(draft.status).toBe("DRAFT");
      expect(draft.tenantId).toBe(tenantId);
      expect(draft.total.amount).toBe(15_000);

      // 审计与业务写在同一事务：报价草稿存在则审计必然存在。
      const audit = await session.db.execute(
        sql`SELECT action, tenant_id FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY seq`,
      );
      const actions = audit.rows.map((row) => row.action);
      expect(actions).toContain("CUSTOMER_CREATED");
      expect(actions).toContain("SAMPLE_CREATED");
      expect(actions).toContain("QUOTE_DRAFT_GENERATED");
      expect(audit.rows.every((row) => row.tenant_id === tenantId)).toBe(true);
    } finally {
      await session.release();
    }
  });

  it("租户 B 看不到也改不了租户 A 的客户（RLS 拦截）", async (ctx) => {
    if (!available) ctx.skip();
    const a = await bootstrapTenant("a");
    const b = await bootstrapTenant("b");

    const scopeA = await tenantKernel(a.tenantId);
    let customerId = "";
    try {
      const customer = await scopeA.kernel.customers.create(
        { code: `ISO-${suffix()}`, name: "A 的私有客户" },
        HUMAN,
      );
      customerId = customer.id;
    } finally {
      await scopeA.session.release();
    }

    const scopeB = await tenantKernel(b.tenantId);
    try {
      await expect(scopeB.kernel.customers.getById(customerId)).rejects.toMatchObject({
        code: "CUSTOMER_NOT_FOUND",
      });
      const visible = await scopeB.session.db.execute(
        sql`SELECT id FROM customers WHERE id = ${customerId}`,
      );
      expect(visible.rows).toHaveLength(0);

      const list = await scopeB.kernel.customers.list(100);
      expect(list.some((row) => row.id === customerId)).toBe(false);
    } finally {
      await scopeB.session.release();
    }

    // 越权写入同样被 WITH CHECK 拒绝
    const scopeBWrite = await tenantKernel(b.tenantId);
    try {
      await expect(
        scopeBWrite.session.db.execute(
          sql`UPDATE customers SET name = 'hacked' WHERE id = ${customerId}`,
        ),
      ).resolves.toBeDefined();
      const ownerRows = await ownerPool!.query<{ name: string }>(
        "SELECT name FROM customers WHERE id = $1",
        [customerId],
      );
      expect(ownerRows.rows[0]?.name).toBe("A 的私有客户");
    } finally {
      await scopeBWrite.session.release();
    }
  });

  it("(sub, org) 映射到本地 membership；org 不一致拒绝", async (ctx) => {
    if (!available || !ownerDb) ctx.skip();
    const a = await bootstrapTenant("auth");
    const kernel = createKernel(ownerDb!);
    const membership = await kernel.tenancy.resolveMembership(a.subject, "org-auth");
    expect(membership.tenantId).toBe(a.tenantId);
    await expect(kernel.tenancy.resolveMembership(a.subject, "org-other")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});
