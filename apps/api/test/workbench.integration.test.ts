import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 订单列表 / 应收对账工作面的集成验收（真实 PostgreSQL）。
 *
 * 覆盖验收 1-4：
 * - 30 张单首屏 20 条、游标翻页不重不漏、逾期压在最前；
 * - 漏斗数字与「按状态筛选」的列表条数一致；
 * - 登记回款后余额与逾期分组立即变化；
 * - 对账单能给出「哪几笔订单、哪几笔回款」，金额整数分。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "workbench-bootstrap" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "workbench-owner", role: "OWNER" } };

let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const createdTenants: string[] = [];

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.receivable_payments') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (pool && available && createdTenants.length > 0) {
    await pool.query("DELETE FROM receivable_payments WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM receivables WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM order_items WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM orders WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM memberships WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

async function tenantKernel(id: string): Promise<Kernel> {
  if (!db) throw new Error("数据库不可用");
  const bootstrap = createKernel(db);
  const tenant = await bootstrap.tenancy.createTenant(
    { slug: `wb-${id}`, name: `Workbench ${id}`, casdoorOrg: `wb-${id}` },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  return createKernel(db, undefined, { tenantId: tenant.id });
}

async function seedOrder(
  kernel: Kernel,
  input: {
    customerId: string;
    sampleId: string;
    code: string;
    dueDate: string | null;
    confirm: boolean;
  },
) {
  const order = await kernel.orders.create(
    {
      customerId: input.customerId,
      code: input.code,
      currency: "CNY",
      dueDate: input.dueDate,
      items: [
        {
          sampleId: input.sampleId,
          quantity: { value: 10, unit: "meter" },
          unitPrice: { amount: 1_000, currency: "CNY" },
        },
      ],
    },
    HUMAN,
  );
  return input.confirm ? await kernel.orders.confirm(order.id, HUMAN) : order;
}

describe("订单工作面（集成）", () => {
  it("30 张单：首屏 20 条、游标加载下一页、逾期排最前", async (ctx) => {
    if (!available) return ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `WB-C-${id}`, name: "工作面客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `WB-S-${id}`,
        name: "工作面面料",
        unit: "meter",
        costFloor: { amount: 500, currency: "CNY" },
      },
      HUMAN,
    );

    const dayMs = 86_400_000;
    const now = Date.now();
    for (let index = 0; index < 30; index += 1) {
      // 前 10 张已逾期，后 20 张交期在未来；顺序故意打乱，验证由 SQL 排序。
      const offsetDays = index % 2 === 0 ? -(index + 1) : 30 + index;
      await seedOrder(kernel, {
        customerId: customer.id,
        sampleId: sample.id,
        code: `WB-${id}-${index.toString().padStart(2, "0")}`,
        dueDate: new Date(now + offsetDays * dayMs).toISOString(),
        confirm: true,
      });
    }

    const first = await kernel.workbench.listOrders({ limit: 20 }, HUMAN);
    expect(first.orders).toHaveLength(20);
    expect(first.total).toBe(30);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const dueTimes = first.orders.map((order) => new Date(order.dueDate as string).getTime());
    expect(dueTimes).toEqual([...dueTimes].sort((a, b) => a - b));
    expect(first.orders[0]?.overdue).toBe(true);

    const second = await kernel.workbench.listOrders(
      { limit: 20, cursor: first.nextCursor },
      HUMAN,
    );
    expect(second.orders).toHaveLength(10);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.orders, ...second.orders].map((order) => order.id);
    expect(new Set(ids).size).toBe(30);
  }, 90_000);

  it("漏斗数字 = 同状态列表条数", async (ctx) => {
    if (!available) return ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create({ code: `WB-C-${id}`, name: "漏斗客户" }, HUMAN);
    const sample = await kernel.samples.create(
      {
        code: `WB-S-${id}`,
        name: "漏斗面料",
        unit: "meter",
        costFloor: { amount: 500, currency: "CNY" },
      },
      HUMAN,
    );
    for (let index = 0; index < 4; index += 1) {
      await seedOrder(kernel, {
        customerId: customer.id,
        sampleId: sample.id,
        code: `WBF-${id}-${index}`,
        dueDate: new Date(Date.now() + index * 86_400_000).toISOString(),
        confirm: true,
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await seedOrder(kernel, {
        customerId: customer.id,
        sampleId: sample.id,
        code: `WBD-${id}-${index}`,
        dueDate: null,
        confirm: false,
      });
    }

    const funnel = await kernel.workbench.orderFunnel({}, HUMAN);
    const byKey = new Map(funnel.stages.map((stage) => [stage.key, stage]));
    expect(byKey.get("DRAFT")?.count).toBe(2);
    expect(byKey.get("CONFIRMED")?.count).toBe(4);

    for (const stage of funnel.stages) {
      const list = await kernel.workbench.listOrders(
        { limit: 50, statuses: stage.statuses },
        HUMAN,
      );
      expect(list.total).toBe(stage.count);
    }
  }, 90_000);

  it("回款登记写流水，余额与逾期分组同步；对账单能点开来源", async (ctx) => {
    if (!available) return ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create({ code: `WB-C-${id}`, name: "对账客户" }, HUMAN);
    const sample = await kernel.samples.create(
      {
        code: `WB-S-${id}`,
        name: "对账面料",
        unit: "meter",
        costFloor: { amount: 500, currency: "CNY" },
      },
      HUMAN,
    );
    const order = await seedOrder(kernel, {
      customerId: customer.id,
      sampleId: sample.id,
      code: `WBR-${id}`,
      dueDate: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      confirm: true,
    });

    const receivable = await kernel.receivables.create(
      {
        orderId: order.id,
        amount: { amount: order.total.amount, currency: "CNY" },
        dueDate: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      },
      HUMAN,
    );

    const before = await kernel.workbench.listReceivables({ bucket: "overdue", limit: 20 }, HUMAN);
    expect(before.receivables.map((row) => row.id)).toContain(receivable.id);
    expect(before.receivables[0]?.status).toBe("OVERDUE");
    expect(before.summary.overdue).toBe(1);

    await kernel.receivables.recordPayment(
      {
        receivableId: receivable.id,
        amount: { amount: 5_000, currency: "CNY" },
        note: "首笔回款",
        paidAt: new Date().toISOString(),
      },
      HUMAN,
    );

    const payments = await kernel.receivables.listPayments(receivable.id, HUMAN);
    expect(payments).toHaveLength(1);
    expect(payments[0]?.amount.amount).toBe(5_000);
    expect(payments[0]?.note).toBe("首笔回款");

    const after = await kernel.workbench.listReceivables({ bucket: "all", limit: 20 }, HUMAN);
    const row = after.receivables.find((entry) => entry.id === receivable.id);
    expect(row?.paidAmount.amount).toBe(5_000);
    expect(row?.balance.amount).toBe(receivable.amount.amount - 5_000);
    expect(row?.lastPaymentAt).not.toBeNull();

    const statement = await kernel.workbench.customerStatement(
      customer.id,
      {},
      () => Promise.resolve(null),
      HUMAN,
    );
    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]?.orderCode).toBe(order.code);
    expect(statement.lines[0]?.payments).toHaveLength(1);
    expect(statement.totalsByCurrency[0]).toEqual({
      currency: "CNY",
      amount: receivable.amount.amount,
      paid: 5_000,
      balance: receivable.amount.amount - 5_000,
    });
    expect(statement.legacyPaidByCurrency).toEqual([]);

    // 补登历史回款：返回值必须是刚插入的这笔，而不是「按到账日倒序的第一条」。
    const backdated = await kernel.receivables.recordPayment(
      {
        receivableId: receivable.id,
        amount: { amount: 1_000, currency: "CNY" },
        paidAt: "2020-01-02T00:00:00.000Z",
        note: "补登历史回款",
      },
      HUMAN,
    );
    expect(backdated.payment.amount.amount).toBe(1_000);
    expect(backdated.payment.paidAt).toBe("2020-01-02T00:00:00.000Z");
    const listed = await kernel.receivables.listPayments(receivable.id, HUMAN);
    expect(listed[0]?.id).not.toBe(backdated.payment.id);

    await expect(
      kernel.receivables.recordPayment(
        {
          receivableId: receivable.id,
          amount: { amount: 1_000, currency: "CNY" },
          proofObjectKey: "tenant/other/receipts/x.jpg",
        },
        HUMAN,
      ),
    ).rejects.toMatchObject({ details: { reason: "PROOF_KEY_INVALID" } });
  }, 90_000);

  it("sales 数据范围：只看得到自己客户的订单", async (ctx) => {
    if (!available) return ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const memberA = randomUUID();
    const memberB = randomUUID();
    const salesA: KernelContext = {
      actor: { type: "HUMAN", id: "sales-a", role: "SALES" },
      dataScope: "OWN",
      ownerId: memberA,
      teamId: null,
    };
    const salesB: KernelContext = {
      actor: { type: "HUMAN", id: "sales-b", role: "SALES" },
      dataScope: "OWN",
      ownerId: memberB,
      teamId: null,
    };
    const customer = await kernel.customers.create(
      { code: `WB-C-${id}`, name: "销售 A 的客户" },
      salesA,
    );
    const sample = await kernel.samples.create(
      {
        code: `WB-S-${id}`,
        name: "共享面料",
        unit: "meter",
        costFloor: { amount: 500, currency: "CNY" },
      },
      SYSTEM,
    );
    await seedOrder(kernel, {
      customerId: customer.id,
      sampleId: sample.id,
      code: `WBS-${id}`,
      dueDate: new Date().toISOString(),
      confirm: false,
    });

    const mine = await kernel.workbench.listOrders({ limit: 20 }, salesA);
    expect(mine.total).toBe(1);
    const others = await kernel.workbench.listOrders({ limit: 20 }, salesB);
    expect(others.total).toBe(0);
  }, 60_000);
});
