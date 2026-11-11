import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel, errorChainMessage } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 内核集成测试：需要本地 PostgreSQL（docker compose up -d && pnpm db:migrate）。
 * 没有数据库时整组跳过，`pnpm test` 在纯离线环境仍然全绿。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "integration-human" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "integration-agent" } };

let probe: Pool | null = null;
let available = false;
let db: Db | null = null;

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customer_contexts') IS NOT NULL AS exists",
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

function kernelOf(): Kernel {
  if (!db) throw new Error("数据库不可用");
  return createKernel(db);
}

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

describe("确定性内核（集成）", () => {
  it("建客户：业务表与审计日志在同一事务写入", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const code = `IT-CUST-${suffix()}`;
    const customer = await kernel.customers.create({ code, name: "集成测试客户" }, HUMAN);

    const context = await kernel.customers.getContext(customer.id);
    expect(context.customerId).toBe(customer.id);
    expect(context.decisionDeltas).toEqual([]);

    const audit = await kernel.audit.list(5);
    const record = audit.find(
      (row) => row.action === "CUSTOMER_CREATED" && row.entityId === customer.id,
    );
    expect(record).toBeDefined();
    expect(record?.actorType).toBe("HUMAN");
    expect(record?.after).toMatchObject({ code, name: "集成测试客户" });
  }, 20_000);

  it("客户编号重复：内核返回 KERNEL_REJECTED / CUSTOMER_CODE_EXISTS", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const code = `IT-DUP-${suffix()}`;
    await kernel.customers.create({ code, name: "第一次" }, HUMAN);
    await expect(kernel.customers.create({ code, name: "第二次" }, HUMAN)).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "CUSTOMER_CODE_EXISTS" },
    });
  }, 20_000);

  it("寄样单：智能体只能建 DRAFT，确认必须人类（铁律 #2）", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `IT-SHIP-C-${id}`, name: "寄样测试客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      { code: `IT-SHIP-S-${id}`, name: "测试面料", unit: "meter" },
      HUMAN,
    );

    const draft = await kernel.shipments.createDraft(
      {
        customerId: customer.id,
        items: [{ sampleId: sample.id, quantity: { value: 2.5, unit: "meter" } }],
      },
      AGENT,
    );
    expect(draft.status).toBe("DRAFT");
    expect(draft.items[0]?.quantity.value).toBe(2.5);

    await expect(kernel.shipments.confirm(draft.id, AGENT)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    const confirmed = await kernel.shipments.confirm(draft.id, HUMAN);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedBy).toBe(HUMAN.actor.id);

    await expect(kernel.shipments.confirm(draft.id, HUMAN)).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "INVALID_STATE_TRANSITION" },
    });
  }, 20_000);

  it("报价：金额由内核整数计算，低于成本底线被拒", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `IT-Q-C-${id}`, name: "报价测试客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `IT-Q-S-${id}`,
        name: "报价面料",
        unit: "meter",
        costFloor: { amount: 1200, currency: "CNY" },
      },
      HUMAN,
    );

    const draft = await kernel.quotes.generateDraft(
      {
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 120.5, unit: "meter" },
            unitPrice: { amount: 1500, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
    expect(draft.status).toBe("DRAFT");
    expect(draft.amountsComputedByKernel).toBe(true);
    expect(draft.items[0]?.lineTotal.amount).toBe(180750);
    expect(draft.total.amount).toBe(180750);

    await expect(
      kernel.quotes.generateDraft(
        {
          customerId: customer.id,
          currency: "CNY",
          items: [
            {
              fabricSampleId: sample.id,
              quantity: { value: 10, unit: "meter" },
              unitPrice: { amount: 800, currency: "CNY" },
            },
          ],
        },
        AGENT,
      ),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "PRICE_BELOW_COST_FLOOR" },
    });

    await expect(kernel.quotes.confirmDraft(draft.id, AGENT)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  }, 20_000);

  it("审计日志：数据库层面禁止 UPDATE / DELETE", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const latest = await kernel.audit.list(1);
    const target = latest[0];
    expect(target).toBeDefined();
    const failure = await db!
      .execute(sql`UPDATE audit_log SET actor_id = 'tampered' WHERE seq = ${target!.seq}`)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect(errorChainMessage(failure)).toContain("append-only");
  }, 20_000);
});
