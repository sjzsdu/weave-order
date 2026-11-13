import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel, isKernelError } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 并发一致性回归：回款累加、寄样确认、发货确认。
 *
 * 与仓库其它集成测试一样做「无库探测」：没有本地 PostgreSQL 时整组跳过；
 * 一旦有库（docker compose up -d && pnpm db:migrate）就真的并发打请求。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "concurrency-human" } };

let probe: Pool | null = null;
let available = false;
let db: Db | null = null;

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      `SELECT to_regclass('public.receivables') IS NOT NULL
          AND to_regclass('public.sample_shipments') IS NOT NULL AS exists`,
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

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 建客户 + 样品 + 已确认订单 + 应收，返回应收 id。 */
async function seedReceivable(
  kernel: Kernel,
  cents: number,
): Promise<{ receivableId: string; orderId: string }> {
  const id = suffix();
  const customer = await kernel.customers.create(
    { code: `CC-C-${id}`, name: "并发测试客户" },
    HUMAN,
  );
  const sample = await kernel.samples.create(
    {
      code: `CC-S-${id}`,
      name: "并发测试面料",
      unit: "meter",
      costFloor: { amount: 1, currency: "CNY" },
    },
    HUMAN,
  );
  const order = await kernel.orders.create(
    {
      customerId: customer.id,
      code: `CC-O-${id}`,
      currency: "CNY",
      items: [
        {
          sampleId: sample.id,
          quantity: { value: 1, unit: "meter" },
          unitPrice: { amount: cents, currency: "CNY" },
        },
      ],
    },
    HUMAN,
  );
  expect(order.total.amount).toBe(cents);
  await kernel.orders.confirm(order.id, HUMAN);
  const receivable = await kernel.receivables.create(
    {
      orderId: order.id,
      amount: { amount: cents, currency: "CNY" },
      dueDate: "2026-12-31T00:00:00.000Z",
    },
    HUMAN,
  );
  return { receivableId: receivable.id, orderId: order.id };
}

function pay(kernel: Kernel, receivableId: string, cents: number) {
  return kernel.receivables.recordPayment(
    { receivableId, amount: { amount: cents, currency: "CNY" } },
    HUMAN,
  );
}

function rejectionReason(reason: unknown): string | undefined {
  if (!isKernelError(reason)) return undefined;
  const details = reason.details as { reason?: string } | undefined;
  return details?.reason;
}

function expectValidRejection(reason: unknown) {
  expect(isKernelError(reason)).toBe(true);
  expect(["PAYMENT_EXCEEDS_REMAINING", "VERSION_CONFLICT"]).toContain(rejectionReason(reason));
}

/**
 * 一个可用余额 1000 分的应收，并发提交两笔 600 分。
 * 正确行为：一笔入账、另一笔因余额不足（或版本冲突）被拒；
 * 错误行为（修复前）：两笔都返回成功，账本却只记 600。
 */
describe("并发回款（集成）", () => {
  it("同一笔应收并发两笔超额收款：20 轮零丢账、零超额", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();

    for (let round = 0; round < 20; round += 1) {
      const { receivableId } = await seedReceivable(kernel, 1000);
      const results = await Promise.allSettled([
        pay(kernel, receivableId, 600),
        pay(kernel, receivableId, 600),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof pay>>> =>
          result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");

      for (const result of rejected) expectValidRejection(result.reason);

      // 读到的最终账本必须与「成功笔数 × 600」完全一致：既不能丢账（少记），
      // 也不能超额（多记）。
      const persisted = await kernel.receivables.getById(receivableId);
      expect(fulfilled.length).toBe(1);
      expect(persisted.paidAmount.amount).toBe(600);
      expect(persisted.paidAmount.amount).toBeLessThanOrEqual(persisted.amount.amount);
      expect(persisted.status).toBe("PARTIAL");
    }
  }, 120_000);

  it("并发两笔都在余额内：两笔都入账，审计 before 取自锁内值", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const { receivableId } = await seedReceivable(kernel, 1000);

    const results = await Promise.allSettled([
      pay(kernel, receivableId, 400),
      pay(kernel, receivableId, 400),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const persisted = await kernel.receivables.getById(receivableId);
    expect(persisted.paidAmount.amount).toBe(800);
    expect(persisted.status).toBe("PARTIAL");

    // 按 entityId 过滤，避免并行测试把 200 条窗口挤爆（与 WAN-97 同一思路）。
    const entries = (await kernel.audit.list(200, receivableId))
      .filter((entry) => entry.action === "RECEIVABLE_PAYMENT_RECORDED")
      .sort((left, right) => left.seq - right.seq);
    expect(entries).toHaveLength(2);
    const chain = entries.map((entry) => ({
      before: (entry.before as { paidAmount: number }).paidAmount,
      after: (entry.after as { paidAmount: number }).paidAmount,
    }));
    expect(chain).toEqual([
      { before: 0, after: 400 },
      { before: 400, after: 800 },
    ]);
  }, 60_000);

  it("并发五笔 400 分：入账总额与成功笔数一致且不超应收", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const { receivableId } = await seedReceivable(kernel, 1000);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => pay(kernel, receivableId, 400)),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    for (const result of results) {
      if (result.status === "rejected") expectValidRejection(result.reason);
    }

    const persisted = await kernel.receivables.getById(receivableId);
    expect(fulfilled.length).toBe(2);
    expect(persisted.paidAmount.amount).toBe(800);
    expect(persisted.paidAmount.amount).toBe(400 * fulfilled.length);
  }, 60_000);
});

async function seedSampleShipment(kernel: Kernel): Promise<string> {
  const id = suffix();
  const customer = await kernel.customers.create(
    { code: `CC-SC-${id}`, name: "并发寄样客户" },
    HUMAN,
  );
  const sample = await kernel.samples.create(
    { code: `CC-SS-${id}`, name: "并发寄样面料", unit: "meter" },
    HUMAN,
  );
  const draft = await kernel.shipments.createDraft(
    {
      customerId: customer.id,
      items: [{ sampleId: sample.id, quantity: { value: 1, unit: "meter" } }],
    },
    HUMAN,
  );
  return draft.id;
}

describe("并发发货确认（集成）", () => {
  it("寄样单并发双击确认：只有一次确认与一条审计", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const shipmentId = await seedSampleShipment(kernel);

    const results = await Promise.allSettled([
      kernel.shipments.confirm(shipmentId, HUMAN),
      kernel.shipments.confirm(shipmentId, HUMAN),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(["INVALID_STATE_TRANSITION", "VERSION_CONFLICT"]).toContain(
      rejectionReason(rejected[0]!.reason),
    );

    const shipment = await kernel.shipments.getById(shipmentId);
    expect(shipment.status).toBe("CONFIRMED");

    const audits = (await kernel.audit.list(200, shipmentId)).filter(
      (entry) => entry.action === "SAMPLE_SHIPMENT_CONFIRMED",
    );
    expect(audits).toHaveLength(1);

    const after = audits[0]!.after as { status: string; confirmedBy: string };
    expect(after.status).toBe("CONFIRMED");
    expect(after.confirmedBy).toBe(HUMAN.actor.id);
    expect((audits[0]!.before as { status: string }).status).toBe("DRAFT");
  }, 60_000);

  it("订单发货单并发双击 shipments/:id/ship：只有一次确认与一条审计", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `CC-OC-${id}`, name: "并发发货客户" },
      HUMAN,
    );
    const sample = await kernel.samples.create(
      {
        code: `CC-OS-${id}`,
        name: "并发发货面料",
        unit: "meter",
        costFloor: { amount: 1, currency: "CNY" },
      },
      HUMAN,
    );
    const order = await kernel.orders.create(
      {
        customerId: customer.id,
        code: `CC-OO-${id}`,
        currency: "CNY",
        items: [
          {
            sampleId: sample.id,
            quantity: { value: 10, unit: "meter" },
            unitPrice: { amount: 1000, currency: "CNY" },
          },
        ],
      },
      HUMAN,
    );
    await kernel.orders.confirm(order.id, HUMAN);
    const shipment = await kernel.orderShipments.create(
      {
        orderId: order.id,
        items: [{ orderItemId: order.items[0]!.id, quantity: { value: 10, unit: "meter" } }],
      },
      HUMAN,
    );

    const results = await Promise.allSettled([
      kernel.orderShipments.markShipped(shipment.id, HUMAN),
      kernel.orderShipments.markShipped(shipment.id, HUMAN),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(["INVALID_STATE_TRANSITION", "VERSION_CONFLICT"]).toContain(
      rejectionReason(rejected[0]!.reason),
    );

    const persisted = await kernel.orderShipments.getById(shipment.id);
    expect(persisted.status).toBe("SHIPPED");

    const audits = (await kernel.audit.list(200, shipment.id)).filter(
      (entry) => entry.action === "SHIPMENT_CONFIRMED",
    );
    expect(audits).toHaveLength(1);
    expect((audits[0]!.before as { status: string }).status).toBe("DRAFT");
  }, 60_000);
});
