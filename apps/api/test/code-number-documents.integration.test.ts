import { randomUUID } from "node:crypto";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";
import { quoteNumberOf } from "../src/kernel/quotes.service";

/**
 * 编号体系治理在报价/订单/寄样单三类单据上的验收：
 *  - 订单 code 缺省自动生成、显式优先、同租户无法重号；
 *  - 寄样单获得规则编号并出现在读模型；
 *  - 报价 code 入库；历史行（code 空）quoteNumberOf 回退派生外观不变。
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "code-number-docs-test", role: "OWNER" } };

let db: Db | null = null;
let available = false;
const tenantId = randomUUID();
const suffix = () => Math.random().toString(36).slice(2, 8);

let customerId = "";
let sampleId = "";

beforeAll(async () => {
  db = createDb(DATABASE_URL).db;
  try {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`SELECT to_regclass('public.code_rules') IS NOT NULL AS ok`);
    available = true;
    const kernel = createKernel(db, undefined, { tenantId });
    const customer = await kernel.customers.createForHuman({ name: `单据客户-${suffix()}` }, HUMAN);
    customerId = customer.id;
    const sample = await kernel.samples.create(
      {
        code: `DOC-${suffix()}`,
        name: "单据样品",
        unit: "meter",
        costFloor: { amount: 500, currency: "CNY" },
      },
      HUMAN,
    );
    sampleId = sample.id;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available && db) {
    const { sql } = await import("drizzle-orm");
    for (const table of [
      "order_items", "orders", "sample_shipment_items", "sample_shipments",
      "quote_items", "quotes", "code_rules", "code_counters",
    ]) {
      await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id = '${tenantId}'::uuid`));
    }
  }
});

function orderInput(code?: string) {
  return {
    customerId,
    ...(code ? { code } : {}),
    currency: "CNY" as const,
    items: [{ sampleId, quantity: { value: 100, unit: "meter" as const }, unitPrice: { amount: 1800, currency: "CNY" as const } }],
  };
}

describe("编号体系治理 · 报价/订单/寄样单", () => {
  it("订单 code 缺省自动生成、逐字节符合 DD 规则", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const order = await kernel.orders.create(orderInput(), HUMAN);
    expect(order.code).toMatch(/^DD\d{6}-\d{4}$/);
  });

  it("订单显式 code 优先", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const explicit = `ORD-${suffix()}`;
    const order = await kernel.orders.create(orderInput(explicit), HUMAN);
    expect(order.code).toBe(explicit);
  });

  it("订单同租户无法重号（唯一索引拦截）", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const dup = `DUP-${suffix()}`;
    await kernel.orders.create(orderInput(dup), HUMAN);
    await expect(kernel.orders.create(orderInput(dup), HUMAN)).rejects.toThrow();
  });

  it("寄样单获得规则编号并出现在读模型", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const shipment = await kernel.shipments.createDraft(
      { customerId, items: [{ sampleId, quantity: { value: 5, unit: "meter" } }] },
      HUMAN,
    );
    expect(shipment.code).toMatch(/^JY\d{6}-\d{4}$/);
    const fetched = await kernel.shipments.getById(shipment.id, HUMAN);
    expect(fetched.code).toBe(shipment.code);
  });

  it("报价 code 入库；历史行回退派生编号外观不变", async () => {
    if (!available || !db) return;
    const kernel = createKernel(db, undefined, { tenantId });
    const draft = await kernel.quotes.generateDraft(
      {
        customerId,
        currency: "CNY",
        validityDays: 30,
        items: [
          {
            fabricSampleId: sampleId,
            quantity: { value: 100, unit: "meter" },
            unitPrice: { amount: 1800, currency: "CNY" },
          },
        ],
      },
      HUMAN,
    );
    const detail = await kernel.quotes.get(draft.id, HUMAN);
    expect(detail.quoteNumber).toMatch(/^BJ\d{6}-\d{4}$/);
    // 历史行：code 为空 → 回退 BJ-YYYYMMDD-{id前4}
    const id = randomUUID();
    const createdAt = new Date("2026-11-22T00:00:00Z");
    expect(quoteNumberOf({ id, createdAt, code: null })).toBe(
      `BJ-20261122-${id.slice(0, 4).toUpperCase()}`,
    );
  });
});
