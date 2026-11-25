import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sampleShipments } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 按样品批量反查寄样单（真实 PG）。
 *
 * 三条硬要求：
 * - 批量：一次传多个样品，结果按寄样单收敛（一张单含多个样品只出现一次）；
 * - 状态过滤：DRAFT / SHIPPED / CANCELLED 可筛；
 * - 数据范围：他人客户的寄样单按「不存在」返回空，不报错、不泄露。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "shipment-lookup-bootstrap" } };

let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.sample_shipment_items') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (pool && available && createdTenants.length > 0) {
    await pool.query("DELETE FROM sample_shipment_items WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM sample_shipments WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
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

describe("寄样单按样品批量反查", () => {
  it("批量过滤、状态过滤、数据范围越权", async (ctx) => {
    const database = db;
    if (!available || !database) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const bootstrap = createKernel(database);
    const tenant = await bootstrap.tenancy.createTenant(
      { slug: `ship-lookup-${id}`, name: `寄样反查 ${id}`, casdoorOrg: `ship-${id}` },
      SYSTEM,
    );
    createdTenants.push(tenant.id);
    const kernel = createKernel(database, undefined, { tenantId: tenant.id });

    const memberA = await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `ship-a-${id}`,
        casdoorOrg: `ship-${id}`,
        role: "MANAGER",
        dataScope: "OWN",
      },
      SYSTEM,
    );
    const memberB = await kernel.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `ship-b-${id}`,
        casdoorOrg: `ship-${id}`,
        role: "MANAGER",
        dataScope: "OWN",
      },
      SYSTEM,
    );
    const asA = humanCtx("MANAGER", memberA.id, "OWN");
    const asB = humanCtx("MANAGER", memberB.id, "OWN");

    const customerA = await kernel.customers.create({ code: `SHIP-A-${id}`, name: "A 客户" }, asA);
    const customerB = await kernel.customers.create({ code: `SHIP-B-${id}`, name: "B 客户" }, asB);

    const sample = async (code: string) =>
      kernel.samples.create(
        { code: `SHIP-${code}-${id}`, name: `样品 ${code}`, unit: "meter" },
        asA,
      );
    const sample1 = await sample("S1");
    const sample2 = await sample("S2");
    const sample3 = await sample("S3");

    const quantity = { value: 1, unit: "meter" as const };
    const multi = await kernel.shipments.createDraft(
      {
        customerId: customerA.id,
        carrier: "顺丰",
        trackingNumber: "SF-MULTI",
        items: [
          { sampleId: sample1.id, quantity },
          { sampleId: sample2.id, quantity },
        ],
      },
      asA,
    );
    const shipped = await kernel.shipments.createDraft(
      { customerId: customerA.id, items: [{ sampleId: sample1.id, quantity }] },
      asA,
    );
    await database
      .update(sampleShipments)
      .set({ status: "SHIPPED", trackingNumber: "SF-SHIPPED" })
      .where(eq(sampleShipments.id, shipped.id));

    const otherOwners = await kernel.shipments.createDraft(
      { customerId: customerB.id, items: [{ sampleId: sample3.id, quantity }] },
      asB,
    );

    const cancelled = await kernel.shipments.createDraft(
      { customerId: customerA.id, items: [{ sampleId: sample1.id, quantity }] },
      asA,
    );
    await kernel.shipments.reject(cancelled.id, asA, "客户改主意");

    // 批量：sample1 命中三张（多样品单 / 在途 / 已取消），每张只出现一次。
    const all = await kernel.shipments.listBySampleIds([sample1.id, sample2.id], asA);
    expect(new Set(all.map((row) => row.id))).toEqual(
      new Set([multi.id, shipped.id, cancelled.id]),
    );
    expect(all).toHaveLength(3);
    const multiRow = all.find((row) => row.id === multi.id);
    expect(multiRow?.sampleIds.sort()).toEqual([sample1.id, sample2.id].sort());
    expect(multiRow?.customerName).toBe("A 客户");
    expect(multiRow?.carrier).toBe("顺丰");

    // 只查 sample2：只拿到含它的那一张。
    const onlySample2 = await kernel.shipments.listBySampleIds([sample2.id], asA);
    expect(onlySample2.map((row) => row.id)).toEqual([multi.id]);

    // 状态过滤。
    const drafts = await kernel.shipments.listBySampleIds([sample1.id], asA, "DRAFT");
    expect(drafts.map((row) => row.id)).toEqual([multi.id]);
    const shippedOnly = await kernel.shipments.listBySampleIds([sample1.id], asA, "SHIPPED");
    expect(shippedOnly.map((row) => row.id)).toEqual([shipped.id]);
    expect(shippedOnly[0]?.trackingNumber).toBe("SF-SHIPPED");

    // 数据范围：B 客户的寄样单对 A 来说不存在（空数组，不抛错）。
    expect(await kernel.shipments.listBySampleIds([sample3.id], asA)).toEqual([]);
    expect(
      (await kernel.shipments.listBySampleIds([sample3.id], asB)).map((row) => row.id),
    ).toEqual([otherOwners.id]);
    // 混合查询也不会把别人的单夹带出来。
    const mixed = await kernel.shipments.listBySampleIds([sample1.id, sample3.id], asA);
    expect(mixed.every((row) => row.customerId === customerA.id)).toBe(true);

    // 没有数据范围（系统任务）时不受限；空入参直接短路。
    expect(await kernel.shipments.listBySampleIds([sample3.id], SYSTEM)).toHaveLength(1);
    expect(await kernel.shipments.listBySampleIds([], asA)).toEqual([]);
  });
});
