import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, orders, quotes, receivables, sampleShipments } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { AppModule } from "../src/app.module";
import { createKernel, isKernelError } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 客户 360 落库验收（真实 PG）：
 * - 列表 / 汇总 / 时间线三个入口的数字必须一致（同一口径）。
 * - 时间线游标分页：200 条历史也只读一页。
 * - 越权客户统一 404（不是 403，不泄露存在性）。
 * - 切租户后读不到上一租户的客户（租户边界）。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "customer-360-bootstrap" } };

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
      "SELECT to_regclass('public.customer_contexts') IS NOT NULL AND to_regclass('public.receivables') IS NOT NULL AS exists",
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
    await pool.query("DELETE FROM receivables WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM shipment_items WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM shipments WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM order_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM orders WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM sample_shipment_items WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM sample_shipments WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM quote_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM quotes WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM memberships WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

function humanCtx(
  role: "SALES" | "MANAGER",
  membershipId: string,
  dataScope: "OWN" | "ALL",
): KernelContext {
  return {
    actor: { type: "HUMAN", id: `subject-${membershipId}`, role },
    dataScope,
    ownerId: membershipId,
    teamId: null,
  };
}

async function getJson(
  path: string,
  authorization?: string,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
  return { status: response.status, json: await response.json() };
}

async function seedQuote(
  database: Db,
  tenantId: string,
  customerId: string,
  status: "DRAFT" | "SENT",
  totalAmount: number,
  createdAt: Date,
): Promise<string> {
  const rows = await database
    .insert(quotes)
    .values({
      tenantId,
      customerId,
      status,
      currency: "CNY",
      subtotalAmount: totalAmount,
      totalAmount,
      validityDays: 15,
      expiresAt: new Date(Date.now() + 15 * 86400_000),
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: quotes.id });
  return rows[0]!.id;
}

describe("客户 360（真连 PG）", () => {
  it("列表 / 汇总 / 时间线口径一致，时间线游标翻页不重不漏", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const org = `c360-${id}`;
    const bootstrap = createKernel(database);
    const tenant = await bootstrap.tenancy.createTenant(
      { slug: `c360-${id}`, name: `客户360 ${id}`, casdoorOrg: org },
      SYSTEM,
    );
    createdTenants.push(tenant.id);
    const kernel = createKernel(database, undefined, { tenantId: tenant.id });

    const sales = await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `sales-c360-${id}`,
        casdoorOrg: org,
        role: "SALES",
        dataScope: "OWN",
      },
      SYSTEM,
    );
    const manager = await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `manager-c360-${id}`,
        casdoorOrg: org,
        role: "MANAGER",
        dataScope: "ALL",
      },
      SYSTEM,
    );
    const asSales = humanCtx("SALES", sales.id, "OWN");
    const asManager = humanCtx("MANAGER", manager.id, "ALL");

    const customer = await kernel.customers.create(
      { code: `C360-${id}`, name: "口径一致客户" },
      asSales,
    );
    const otherCustomer = await kernel.customers.create(
      { code: `C360-O-${id}`, name: "主管的客户" },
      asManager,
    );

    const now = Date.now();
    // 25 条报价：20 条草稿 + 5 条已发出。用来验证分页与未决口径。
    for (let index = 0; index < 25; index += 1) {
      await seedQuote(
        database,
        tenant.id,
        customer.id,
        index < 20 ? "DRAFT" : "SENT",
        100_000 + index,
        new Date(now - index * 60_000),
      );
    }

    // 在途寄样 = CONFIRMED / SHIPPED；DRAFT 与 DELIVERED 不计。
    const shipmentStatuses = ["DRAFT", "CONFIRMED", "SHIPPED", "DELIVERED"] as const;
    for (const [index, status] of shipmentStatuses.entries()) {
      await database.insert(sampleShipments).values({
        tenantId: tenant.id,
        customerId: customer.id,
        status,
        createdAt: new Date(now - (30 + index) * 60_000),
        updatedAt: new Date(now - (30 + index) * 60_000),
      });
    }

    const orderRows = await database
      .insert(orders)
      .values({
        tenantId: tenant.id,
        customerId: customer.id,
        code: `SO-${id}`,
        status: "CONFIRMED",
        currency: "CNY",
        totalAmount: 1_280_000,
        confirmedAt: new Date(now - 40 * 60_000),
        createdAt: new Date(now - 40 * 60_000),
        updatedAt: new Date(now - 40 * 60_000),
      })
      .returning({ id: orders.id });
    const orderId = orderRows[0]!.id;

    await database.insert(receivables).values([
      {
        tenantId: tenant.id,
        orderId,
        customerId: customer.id,
        amount: 800_000,
        paidAmount: 200_000,
        currency: "CNY",
        dueDate: new Date(now - 3 * 86400_000),
        status: "PARTIAL",
        createdAt: new Date(now - 39 * 60_000),
        updatedAt: new Date(now - 39 * 60_000),
      },
      {
        tenantId: tenant.id,
        orderId,
        customerId: customer.id,
        amount: 480_000,
        paidAmount: 0,
        currency: "USD",
        dueDate: new Date(now + 5 * 86400_000),
        status: "PENDING",
        createdAt: new Date(now - 38 * 60_000),
        updatedAt: new Date(now - 38 * 60_000),
      },
    ]);

    const list = await kernel.customers.list({ limit: 10, owner: "all" }, asSales);
    const row = list.find((entry) => entry.id === customer.id);
    expect(row).toBeDefined();
    const summary = await kernel.customers.customerSummary(customer.id, asSales);
    expect(row!.pendingQuoteCount).toBe(summary.pendingQuoteCount);
    expect(row!.pendingQuoteCount).toBe(20);
    expect(row!.inTransitSampleCount).toBe(summary.inTransitSampleCount);
    expect(row!.inTransitSampleCount).toBe(2);
    expect(summary.activeOrderCount).toBe(1);
    expect(row!.overdueReceivableCount).toBe(1);
    expect(summary.overdueReceivableCount).toBe(1);
    expect(summary.receivableBalance).toEqual(
      expect.arrayContaining([
        { amount: 600_000, currency: "CNY" },
        { amount: 480_000, currency: "USD" },
      ]),
    );

    // 时间线首屏 20 条 + 加载更多；总数 = 25 报价 + 4 寄样 + 1 订单 + 2 回款 + 1 客户创建审计。
    const first = await kernel.customers.customerTimeline(customer.id, { limit: 20 }, asSales);
    expect(first.events).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await kernel.customers.customerTimeline(
      customer.id,
      { limit: 20, cursor: first.nextCursor },
      asSales,
    );
    const ids = [...first.events, ...second.events].map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(32);

    // 每类单据都带可点开的源 id；回款指向订单。
    const receivable = second.events.find((event) => event.kind === "receivable");
    expect(receivable?.sourceId).toBe(orderId);
    const order = second.events.find((event) => event.kind === "order");
    expect(order?.code).toBe(`SO-${id}`);

    // 类型筛选只返回该类型，且分页仍由 SQL 完成。
    const onlyOrders = await kernel.customers.customerTimeline(
      customer.id,
      { kinds: ["order", "receivable"], limit: 10 },
      asSales,
    );
    expect(onlyOrders.events.every((event) => ["order", "receivable"].includes(event.kind))).toBe(
      true,
    );
    expect(onlyOrders.events).toHaveLength(3);

    // recentOrders 已接真表（T-003 不再是空数组）。
    const history = await kernel.customers.getHistory(customer.id, 10, asSales);
    expect(history.recentOrders).toHaveLength(1);
    expect(history.recentOrders[0]?.id).toBe(orderId);
    expect(history.recentOrders[0]?.status).toBe("CONFIRMED");

    // 搜索命中名称 / 编号；「我的」只收窄到负责人。
    const searched = await kernel.customers.list({ query: "口径一致", limit: 10 }, asSales);
    expect(searched.map((entry) => entry.id)).toEqual([customer.id]);
    const mine = await kernel.customers.list({ owner: "mine", limit: 10 }, asSales);
    expect(mine.map((entry) => entry.id)).toEqual([customer.id]);
    const overdue = await kernel.customers.list({ overdueOnly: true, limit: 10 }, asSales);
    expect(overdue.map((entry) => entry.id)).toEqual([customer.id]);

    // 没有任何报价/寄样/订单的客户，「最近联系」必须是 null，不能拿档案更新时间冒充。
    const managerList = await kernel.customers.list({ limit: 10, owner: "all" }, asManager);
    const otherRow = managerList.find((entry) => entry.id === otherCustomer.id);
    expect(otherRow?.lastContactAt).toBeNull();

    // HTTP 面：销售打开主管的客户 -> 404（不是 403，也不泄露存在性）。
    const salesAuth = `Bearer dev:sales-c360-${id}:${org}`;
    const managerAuth = `Bearer dev:manager-c360-${id}:${org}`;
    const denied = await getJson(`/api/customers/${otherCustomer.id}`, salesAuth);
    expect(denied.status).toBe(404);
    const deniedTimeline = await getJson(`/api/customers/${otherCustomer.id}/timeline`, salesAuth);
    expect(deniedTimeline.status).toBe(404);
    const allowed = await getJson(`/api/customers/${customer.id}`, salesAuth);
    expect(allowed.status).toBe(200);
    expect(
      (allowed.json as { summary: { pendingQuoteCount: number } }).summary.pendingQuoteCount,
    ).toBe(20);
    const managerAllowed = await getJson(`/api/customers/${otherCustomer.id}`, managerAuth);
    expect(managerAllowed.status).toBe(200);
    const httpList = await getJson("/api/customers?limit=10&owner=all", salesAuth);
    expect(httpList.status).toBe(200);
    const httpRows = (httpList.json as { customers: Array<Record<string, unknown>> }).customers;
    expect(httpRows[0]).toHaveProperty("inTransitSampleCount");
    expect(httpRows[0]).toHaveProperty("receivableBalance");

    // 切租户：另一个租户的内核读不到本租户客户（同一条 404 口径）。
    const otherOrg = `c360-other-${id}`;
    const otherTenant = await bootstrap.tenancy.createTenant(
      { slug: `c360-other-${id}`, name: `客户360 另一租户 ${id}`, casdoorOrg: otherOrg },
      SYSTEM,
    );
    createdTenants.push(otherTenant.id);
    const otherKernel = createKernel(database, undefined, { tenantId: otherTenant.id });
    await otherKernel.tenancy.createMembership(
      {
        tenantId: otherTenant.id,
        subject: `other-${id}`,
        casdoorOrg: otherOrg,
        role: "OWNER",
        dataScope: "ALL",
      },
      SYSTEM,
    );
    await expect(otherKernel.customers.customer360(customer.id)).rejects.toSatisfy(
      (error: unknown) => isKernelError(error) && error.code === "CUSTOMER_NOT_FOUND",
    );
    const otherAuth = `Bearer dev:other-${id}:${otherOrg}`;
    const crossTenant = await getJson(`/api/customers/${customer.id}`, otherAuth);
    expect(crossTenant.status).toBe(404);
  }, 90_000);
});
