import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 数据范围落库验收（真实 PG）：
 * 同一租户内 OWN / TEAM / ALL 三种范围 × 客户 / 报价 / 样品 / 定价策略。
 *
 * 归属人 = memberships.id，业务表 customers.owner_id 存的就是它。
 * 报价没有归属人列，归属随客户（这是本议题确定的判定口径）。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "data-scope-bootstrap" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "data-scope-agent" } };

let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
let app: INestApplication | null = null;
let baseUrl = "";
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customers') IS NOT NULL AND to_regclass('public.pricing_policies') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) {
      db = createDb(DATABASE_URL).db;
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0);
      const address = (app.getHttpServer() as Server).address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  if (pool && available && createdTenants.length > 0) {
    await pool.query("DELETE FROM quote_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM quotes WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM sample_embeddings WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM policy_change_log WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM pricing_policies WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM memberships WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

async function getJson(
  path: string,
  authorization?: string,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
  return { status: response.status, json: await response.json() };
}

function humanCtx(
  role: "SALES" | "MANAGER" | "OWNER",
  membershipId: string,
  dataScope: "OWN" | "TEAM" | "ALL",
  teamId: string | null,
): KernelContext {
  return {
    actor: { type: "HUMAN", id: `subject-${membershipId}`, role },
    dataScope,
    ownerId: membershipId,
    teamId,
  };
}

describe("数据范围 OWN / TEAM / ALL", () => {
  it("客户与报价按归属过滤，样品成本底线按角色裁剪", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const kernel = createKernel(database);
    const tenant = await kernel.tenancy.createTenant(
      { slug: `ds-${id}`, name: `数据范围 ${id}`, casdoorOrg: `ds-${id}` },
      SYSTEM,
    );
    createdTenants.push(tenant.id);
    const scoped = createKernel(database, undefined, { tenantId: tenant.id });

    const teamA = randomUUID();
    const teamB = randomUUID();
    const salesA = await scoped.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `sales-a-${id}`,
        casdoorOrg: `ds-${id}`,
        role: "SALES",
        dataScope: "OWN",
        teamId: teamA,
      },
      SYSTEM,
    );
    const salesB = await scoped.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `sales-b-${id}`,
        casdoorOrg: `ds-${id}`,
        role: "SALES",
        dataScope: "TEAM",
        teamId: teamA,
      },
      SYSTEM,
    );
    const salesC = await scoped.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `sales-c-${id}`,
        casdoorOrg: `ds-${id}`,
        role: "MANAGER",
        dataScope: "ALL",
        teamId: teamB,
      },
      SYSTEM,
    );
    const manager = await scoped.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `manager-${id}`,
        casdoorOrg: `ds-${id}`,
        role: "MANAGER",
        dataScope: "TEAM",
        teamId: teamA,
      },
      SYSTEM,
    );

    const asA = humanCtx("SALES", salesA.id, "OWN", teamA);
    const asB = humanCtx("SALES", salesB.id, "TEAM", teamA);
    const asC = humanCtx("MANAGER", salesC.id, "ALL", teamB);
    const asManager = humanCtx("MANAGER", manager.id, "TEAM", teamA);

    const customerA = await scoped.customers.create({ code: `DS-A-${id}`, name: "A 客户" }, asA);
    const customerB = await scoped.customers.create({ code: `DS-B-${id}`, name: "B 客户" }, asB);
    const customerC = await scoped.customers.create({ code: `DS-C-${id}`, name: "C 客户" }, asC);

    // 写路径：人类创建即归属创建人，OWN 范围才可见。
    const listA = await scoped.customers.list(100, asA);
    expect(listA.map((row) => row.id)).toEqual([customerA.id]);

    const listB = await scoped.customers.list(100, asB);
    expect(listB.map((row) => row.id).sort()).toEqual([customerA.id, customerB.id].sort());

    // 「我的」在 TEAM 范围下必须是本组：UI 默认筛选就是 mine，
    // 若收窄成 owner=self，经理切过来会看到空列表（WAN-136）。
    const mineAsManager = await scoped.customers.list({ owner: "mine", limit: 100 }, asManager);
    expect(mineAsManager.map((row) => row.id).sort()).toEqual([customerA.id, customerB.id].sort());

    const listAll = await scoped.customers.list(100, asC);
    expect(listAll.map((row) => row.id).sort()).toEqual(
      [customerA.id, customerB.id, customerC.id].sort(),
    );

    // 单条读取：越权按「不存在」处理，不给枚举信号。
    await expect(scoped.customers.getById(customerC.id, asA)).rejects.toMatchObject({
      code: "CUSTOMER_NOT_FOUND",
    });
    await expect(scoped.customers.getById(customerA.id, asB)).resolves.toMatchObject({
      id: customerA.id,
    });

    // 报价归属随客户：A 只能看到自己客户的报价。
    const sample = await scoped.samples.create(
      {
        code: `DS-S-${id}`,
        name: "数据范围面料",
        unit: "meter",
        costFloor: { amount: 1_000, currency: "CNY" },
      },
      asManager,
    );
    const draftInput = (customerId: string) => ({
      customerId,
      currency: "CNY" as const,
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: 10, unit: "meter" as const },
          unitPrice: { amount: 2_000, currency: "CNY" as const },
        },
      ],
    });
    const quoteA = await scoped.quotes.generateDraft(draftInput(customerA.id), AGENT);
    const quoteC = await scoped.quotes.generateDraft(draftInput(customerC.id), AGENT);

    const quotesA = await scoped.quotes.list(100, asA);
    expect(quotesA.map((item) => item.id)).toEqual([quoteA.id]);
    expect((await scoped.quotes.list(100, asC)).map((item) => item.id).sort()).toEqual(
      [quoteA.id, quoteC.id].sort(),
    );
    await expect(scoped.quotes.get(quoteC.id, asA)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });

    // 字段裁剪：sales 拿不到成本底线，manager 拿得到。
    const samplesAsSales = await scoped.search.listSamples(10, asA);
    expect(samplesAsSales.find((row) => row.id === sample.id)?.costFloor).toBeNull();
    const samplesAsManager = await scoped.search.listSamples(10, asManager);
    expect(samplesAsManager.find((row) => row.id === sample.id)?.costFloor).toEqual({
      amount: 1_000,
      currency: "CNY",
    });
    // 内核内部（智能体/工具）仍能读到完整底线，计价不受裁剪影响。
    const full = await scoped.samples.getById(sample.id);
    expect(full.costFloor).toEqual({ amount: 1_000, currency: "CNY" });

    // 个人定价策略：非 ALL 角色看不到同事的个人档位。
    await scoped.pricing.create(
      {
        scopeType: "PERSON",
        scopeId: salesB.id,
        key: "approval.sales.limit",
        value: 3_000_000,
      },
      asManager,
    );
    const policiesForA = await scoped.pricing.list({ scopeType: "PERSON" }, asA);
    expect(policiesForA).toHaveLength(0);
    const policiesForB = await scoped.pricing.list({ scopeType: "PERSON" }, asB);
    expect(policiesForB.map((policy) => policy.scopeId)).toEqual([salesB.id]);
    const policiesForAll = await scoped.pricing.list({ scopeType: "PERSON" }, asC);
    expect(policiesForAll.map((policy) => policy.scopeId)).toEqual([salesB.id]);

    // 策略列表游标分页：先按可见范围过滤，再分页，翻页不漏不重。
    await scoped.pricing.create(
      {
        scopeType: "PERSON",
        scopeId: salesB.id,
        key: "pricing.default_margin_pct",
        value: 18,
      },
      asManager,
    );
    const pageOne = await scoped.pricing.listPage({ scopeType: "PERSON" }, asB, { limit: 1 });
    expect(pageOne.policies).toHaveLength(1);
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).toBeTruthy();
    const pageTwo = await scoped.pricing.listPage({ scopeType: "PERSON" }, asB, {
      limit: 1,
      cursor: pageOne.nextCursor,
    });
    const pagedIds = [...pageOne.policies, ...pageTwo.policies].map((policy) => policy.id);
    expect(pageTwo.hasMore).toBe(false);
    expect(new Set(pagedIds).size).toBe(2);
    // 他人依旧看不到：过滤与分页在同一条 SQL，不会因翻页泄露。
    expect(
      (await scoped.pricing.listPage({ scopeType: "PERSON" }, asA, { limit: 1 })).policies,
    ).toHaveLength(0);
  }, 60_000);
});

describe("数据范围 HTTP 面（真起服务 + 真连 PG）", () => {
  it("客户/样品按登录成员范围过滤，他人 personId 的 resolve 被拒", async (ctx) => {
    const database = db;
    if (!available || !database || !app) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const org = `ds-http-${id}`;
    const kernel = createKernel(database);
    const tenant = await kernel.tenancy.createTenant(
      { slug: `ds-http-${id}`, name: `数据范围 HTTP ${id}`, casdoorOrg: org },
      SYSTEM,
    );
    createdTenants.push(tenant.id);
    const scoped = createKernel(database, undefined, { tenantId: tenant.id });

    const salesSubject = `sales-${id}`;
    const managerSubject = `manager-${id}`;
    const sales = await scoped.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: salesSubject,
        casdoorOrg: org,
        role: "SALES",
        dataScope: "OWN",
      },
      SYSTEM,
    );
    const manager = await scoped.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: managerSubject,
        casdoorOrg: org,
        role: "MANAGER",
        dataScope: "ALL",
      },
      SYSTEM,
    );

    const asSales = humanCtx("SALES", sales.id, "OWN", null);
    const asManager = humanCtx("MANAGER", manager.id, "ALL", null);
    const ownCustomer = await scoped.customers.create(
      { code: `DSH-A-${id}`, name: "业务员自己的客户" },
      asSales,
    );
    const otherCustomer = await scoped.customers.create(
      { code: `DSH-B-${id}`, name: "主管的客户" },
      asManager,
    );
    const sample = await scoped.samples.create(
      {
        code: `DSH-S-${id}`,
        name: "HTTP 数据范围面料",
        unit: "meter",
        costFloor: { amount: 800, currency: "CNY" },
      },
      asManager,
    );
    await scoped.pricing.create(
      {
        scopeType: "PERSON",
        scopeId: manager.id,
        key: "approval.sales.limit",
        value: 9_000_000,
      },
      asManager,
    );

    const salesAuth = `Bearer dev:${salesSubject}:${org}`;
    const managerAuth = `Bearer dev:${managerSubject}:${org}`;

    const salesCustomers = await getJson("/api/customers?limit=100", salesAuth);
    expect(salesCustomers.status).toBe(200);
    const salesIds = (salesCustomers.json as { customers: Array<{ id: string }> }).customers.map(
      (row) => row.id,
    );
    expect(salesIds).toEqual([ownCustomer.id]);

    const managerCustomers = await getJson("/api/customers?limit=100", managerAuth);
    const managerIds = (
      managerCustomers.json as { customers: Array<{ id: string }> }
    ).customers.map((row) => row.id);
    expect(managerIds.sort()).toEqual([ownCustomer.id, otherCustomer.id].sort());

    const salesSamples = await getJson("/api/samples?limit=100", salesAuth);
    const salesSample = (
      salesSamples.json as { samples: Array<{ id: string; costFloor: unknown }> }
    ).samples.find((row) => row.id === sample.id);
    expect(salesSample?.costFloor).toBeNull();

    const managerSamples = await getJson("/api/samples?limit=100", managerAuth);
    const managerSample = (
      managerSamples.json as { samples: Array<{ id: string; costFloor: unknown }> }
    ).samples.find((row) => row.id === sample.id);
    expect(managerSample?.costFloor).toEqual({ amount: 800, currency: "CNY" });

    // 非本人 personId：业务员探测主管的个人限额必须被拒。
    const forbidden = await getJson(
      `/api/pricing/resolve?key=approval.sales.limit&personId=${manager.id}`,
      salesAuth,
    );
    expect(forbidden.status).toBe(403);

    // 本人 personId 与管理者跨人查询都放行。
    const self = await getJson(
      `/api/pricing/resolve?key=approval.sales.limit&personId=${sales.id}`,
      salesAuth,
    );
    expect(self.status).toBe(200);
    const cross = await getJson(
      `/api/pricing/resolve?key=approval.sales.limit&personId=${manager.id}`,
      managerAuth,
    );
    expect(cross.status).toBe(200);
    expect((cross.json as { resolved: { key: string } }).resolved.key).toBe("approval.sales.limit");
  }, 60_000);
});
