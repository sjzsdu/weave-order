import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 管控键口径收敛（WAN-97）的集成回归。
 *
 * 覆盖两个曾被绕过的缺口：
 * 1. `pricing.reprice_escalation_*` 之前不在 CONTROL 集合里，MANAGER 在
 *    CUSTOMER/PERSON 层放大阈值即可让「改价超阈值升级」失效。
 * 2. 系统推荐值之前不参与夹取，公司层没配 `approval.*` 时，CUSTOMER 层的
 *    巨大值可以直接生效。
 *
 * 与仓库既有集成测试同款「无库探测」：有 PG 就真跑，没有则整组跳过
 * （CI 上必须有库并真的跑，参考 track-a.integration.test.ts）。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const OWNER: KernelContext = { actor: { type: "HUMAN", id: "pricing-ctrl-owner", role: "OWNER" } };
const MANAGER: KernelContext = {
  actor: { type: "HUMAN", id: "pricing-ctrl-manager", role: "MANAGER" },
};
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "pricing-ctrl-bootstrap" } };

let probe: Pool | null = null;
let available = false;
let db: Db | null = null;

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.pricing_policies') IS NOT NULL AS exists",
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

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function tenantKernel(id: string): Promise<Kernel> {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `pc-${id}`, name: `Pricing Control ${id}`, casdoorOrg: `pc-${id}` },
    SYSTEM,
  );
  return createKernel(db, undefined, { tenantId: tenant.id });
}

describe("管控键口径收敛：系统推荐值参与夹取（WAN-97）", () => {
  it("MANAGER 在 PERSON 层放大 reprice_escalation_pct 被夹回系统推荐值", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const personId = "sales-lina";

    // MANAGER 可以建 PERSON 层策略，但不能把管控键放宽到系统推荐值之外。
    await kernel.pricing.create(
      {
        scopeType: "PERSON",
        scopeId: personId,
        key: "pricing.reprice_escalation_pct",
        value: 100_000,
        locked: true,
      },
      MANAGER,
    );

    const resolved = await kernel.pricing.resolve("pricing.reprice_escalation_pct", { personId });
    // 系统推荐 5%，PERSON 想放成 100000%，被夹回 5%。
    expect(resolved.value).toBe(5);
    expect(resolved.clamped).toBe(true);
    expect(resolved.source.kind).toBe("SYSTEM_DEFAULT");
  }, 20_000);

  it("MANAGER 在 CUSTOMER 层放大 reprice_escalation_amount 被夹回系统推荐值", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `PC-C-${id}`, name: "管控键客户" },
      OWNER,
    );

    await kernel.pricing.create(
      {
        scopeType: "CUSTOMER",
        scopeId: customer.id,
        key: "pricing.reprice_escalation_amount",
        value: 100_000_000,
      },
      MANAGER,
    );

    const resolved = await kernel.pricing.resolve("pricing.reprice_escalation_amount", {
      customerId: customer.id,
    });
    // 系统推荐 100 万分，CUSTOMER 想放成 1 亿分，被夹回 100 万分。
    expect(resolved.value).toBe(1_000_000);
    expect(resolved.clamped).toBe(true);
    expect(resolved.source.kind).toBe("SYSTEM_DEFAULT");
  }, 20_000);

  it("未配置 approval.* 时，CUSTOMER 层不能把审批上限放到超过系统推荐值", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `PC-A-${id}`, name: "审批上限客户" },
      OWNER,
    );

    // 公司层从未建过 approval.sales.limit。
    await kernel.pricing.create(
      {
        scopeType: "CUSTOMER",
        scopeId: customer.id,
        key: "approval.sales.limit",
        value: 100_000_000,
      },
      OWNER,
    );

    const resolved = await kernel.pricing.resolve("approval.sales.limit", {
      customerId: customer.id,
    });
    // 系统推荐 500 万分，CUSTOMER 想放成 1 亿分，被夹回 500 万分。
    expect(resolved.value).toBe(5_000_000);
    expect(resolved.clamped).toBe(true);
    expect(resolved.source.kind).toBe("SYSTEM_DEFAULT");
  }, 20_000);

  it("下级收紧仍生效：CUSTOMER 把 reprice_escalation_pct 压到 2 不被夹回", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create({ code: `PC-T-${id}`, name: "收紧客户" }, OWNER);

    await kernel.pricing.create(
      {
        scopeType: "CUSTOMER",
        scopeId: customer.id,
        key: "pricing.reprice_escalation_pct",
        value: 2,
      },
      OWNER,
    );

    const resolved = await kernel.pricing.resolve("pricing.reprice_escalation_pct", {
      customerId: customer.id,
    });
    // 收紧（更低阈值 = 更容易升级）是允许的，生效值为 2。
    expect(resolved.value).toBe(2);
    expect(resolved.clamped).toBe(false);
    expect(resolved.source.scopeType).toBe("CUSTOMER");
  }, 20_000);

  it("owner 上限为 null（无上限）不参与夹取，仍可解析为 null", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);

    const resolved = await kernel.pricing.resolve("approval.owner.limit", {});
    expect(resolved.value).toBeNull();
    expect(resolved.source.kind).toBe("SYSTEM_DEFAULT");
    expect(resolved.clamped).toBe(false);
  }, 20_000);
});
