import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, customers, orders, quotes, receivables } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 客户列表排序契约（WAN-186，真连 PG）：
 * - `sort=followup`：有未决报价或逾期应收 → 最近往来倒序 → 等级；
 * - `sort=recent` / 不传：保持新建倒序，旧调用方不受影响；
 * - 未决金额与列表排序同一条 SQL 算出来，接口顺序就是端上顺序；
 * - 非法排序值 400，而不是静默忽略。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "customer-sort-bootstrap" } };

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
      "SELECT to_regclass('public.customer_contacts') IS NOT NULL AND to_regclass('public.receivables') IS NOT NULL AS exists",
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
    for (const table of [
      "receivables",
      "orders",
      "quote_items",
      "quotes",
      "customer_contexts",
      "customer_contacts",
      "customers",
      "memberships",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenants]);
    }
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

describe("客户列表排序（真连 PG）", () => {
  it("followup 先按待跟进分组，再按最近往来与等级；recent 保持新建倒序", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const org = `csort-${id}`;
    const bootstrap = createKernel(database);
    const tenant = await bootstrap.tenancy.createTenant(
      { slug: `csort-${id}`, name: `客户排序 ${id}`, casdoorOrg: org },
      SYSTEM,
    );
    createdTenants.push(tenant.id);
    const kernel = createKernel(database, undefined, { tenantId: tenant.id });
    await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `sales-csort-${id}`,
        displayName: "排序销售",
        casdoorOrg: org,
        role: "SALES",
        dataScope: "ALL",
      },
      SYSTEM,
    );

    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
    // 创建时间：A 最早，D 最新。端上默认（recent）应看到 D C B A。
    const a = await seedCustomer(database, kernel, `CS-A-${id}`, "A 沉睡无往来", "COLD", at(100));
    const b = await seedCustomer(database, kernel, `CS-B-${id}`, "B VIP 待跟进旧", "VIP", at(90));
    const c = await seedCustomer(database, kernel, `CS-C-${id}`, "C 沉睡逾期最近", "COLD", at(80));
    const d = await seedCustomer(
      database,
      kernel,
      `CS-D-${id}`,
      "D 常规无未决较近",
      "REGULAR",
      at(70),
    );

    // B：两张草稿（未决金额 1,250.00），最近往来 48 小时前。
    await seedQuote(database, tenant.id, b, "DRAFT", 100_000, at(48));
    await seedQuote(database, tenant.id, b, "DRAFT", 25_000, at(60));
    // C：只有一张已发出报价（不算未决），但有一笔逾期应收 → 仍进待跟进组；最近往来最新。
    await seedQuote(database, tenant.id, c, "SENT", 500_000, at(1));
    await seedOverdueReceivable(database, tenant.id, c, at(1));
    // D：已发出报价，没有未决/逾期；最近往来 5 小时前。
    await seedQuote(database, tenant.id, d, "SENT", 300_000, at(5));
    // A：没有任何往来 → lastContactAt 为 null，排最后。

    const followup = await kernel.customers.list(
      { sort: "followup", limit: 20, owner: "all" },
      SYSTEM,
    );
    expect(followup.map((row) => row.id)).toEqual([c, b, d, a]);

    // 未决金额按币种分组，只算 DRAFT；接口顺序与数字同一条 SQL 产出。
    const bRow = followup.find((row) => row.id === b);
    expect(bRow?.pendingQuoteCount).toBe(2);
    expect(bRow?.pendingQuoteAmount).toEqual([{ amount: 125_000, currency: "CNY" }]);
    const cRow = followup.find((row) => row.id === c);
    expect(cRow?.pendingQuoteCount).toBe(0);
    expect(cRow?.pendingQuoteAmount).toEqual([]);
    expect(cRow?.overdueReceivableCount).toBe(1);

    const recent = await kernel.customers.list({ sort: "recent", limit: 20, owner: "all" }, SYSTEM);
    expect(recent.map((row) => row.id)).toEqual([d, c, b, a]);

    // HTTP 面：销售用 dev 令牌走真实控制器，顺序与内核一致。
    const auth = `Bearer dev:sales-csort-${id}:${org}`;
    const httpFollowup = await getJson("/api/customers?limit=20&owner=all&sort=followup", auth);
    expect(httpFollowup.status).toBe(200);
    const rows = (httpFollowup.json as { customers: Array<{ id: string }> }).customers;
    expect(rows.map((row) => row.id)).toEqual([c, b, d, a]);
    expect(rows[0]).toHaveProperty("pendingQuoteAmount");

    // 非法排序值必须 400：客户端拼错参数时不能让服务端悄悄按默认排序。
    const bad = await getJson("/api/customers?sort=followup%3Bdrop", auth);
    expect(bad.status).toBe(400);
  });
});

async function seedCustomer(
  database: Db,
  kernel: ReturnType<typeof createKernel>,
  code: string,
  name: string,
  tier: string,
  createdAt: Date,
): Promise<string> {
  const customer = await kernel.customers.create({ code, name, tier }, SYSTEM);
  // 客户创建只会写 now()，排序测试需要可控的创建时间；直接改回测试库。
  await database
    .update(customers)
    .set({ createdAt, updatedAt: createdAt })
    .where(eq(customers.id, customer.id));
  return customer.id;
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

async function seedOverdueReceivable(
  database: Db,
  tenantId: string,
  customerId: string,
  createdAt: Date,
): Promise<void> {
  const orderRows = await database
    .insert(orders)
    .values({
      tenantId,
      customerId,
      code: `SO-CSORT-${customerId.slice(0, 8)}`,
      status: "CONFIRMED",
      currency: "CNY",
      totalAmount: 200_000,
      confirmedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: orders.id });
  await database.insert(receivables).values({
    tenantId,
    orderId: orderRows[0]!.id,
    customerId,
    amount: 200_000,
    paidAmount: 0,
    currency: "CNY",
    dueDate: new Date(createdAt.getTime() - 3 * 86400_000),
    status: "PENDING",
    createdAt,
    updatedAt: createdAt,
  });
}
