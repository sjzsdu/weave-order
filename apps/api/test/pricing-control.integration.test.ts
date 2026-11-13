import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 管控键口径收敛（WAN-97）的集成回归。
 *
 * 语义（对齐 product-design §3.5）：系统是「推荐值」，公司级才是「硬边界」。
 * - 公司层（OWNER）可以把自己的阈值设在推荐值之上；
 * - 下级（TEAM/CUSTOMER/CATEGORY/PERSON）只能收紧，不能放宽公司层。
 *
 * 本文件覆盖两件事：
 * 1. `pricing.reprice_escalation_*` 属于管控键（MAX：只能压低），locked 的公司层
 *    策略能把下级试图放宽的值夹回。
 * 2. 系统推荐值**不是**夹取边界——只在没有任何 applicable 策略行时作为默认生效值。
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

describe("管控键口径收敛：系统推荐值非边界（WAN-97）", () => {
  it("OWNER 在 COMPANY 层放大 approval.sales.limit（锁定）→ 生效值就是他设的值", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);

    await kernel.pricing.create(
      {
        scopeType: "COMPANY",
        key: "approval.sales.limit",
        value: 10_000_000,
        locked: true,
      },
      OWNER,
    );

    const resolved = await kernel.pricing.resolve("approval.sales.limit", {});
    // 公司层是硬边界的「来源」，不是被系统推荐值（500 万）夹回的。
    expect(resolved.value).toBe(10_000_000);
    expect(resolved.clamped).toBe(false);
    expect(resolved.source.scopeType).toBe("COMPANY");
    expect(resolved.source.kind).toBe("POLICY");
  }, 20_000);

  it("CUSTOMER 层放大 approval.sales.limit → 被公司层 locked 边界夹回", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `PC-A-${id}`, name: "审批上限客户" },
      OWNER,
    );

    await kernel.pricing.create(
      {
        scopeType: "COMPANY",
        key: "approval.sales.limit",
        value: 5_000_000,
        locked: true,
      },
      OWNER,
    );
    await kernel.pricing.create(
      {
        scopeType: "CUSTOMER",
        scopeId: customer.id,
        key: "approval.sales.limit",
        value: 100_000_000,
      },
      MANAGER,
    );

    const resolved = await kernel.pricing.resolve("approval.sales.limit", {
      customerId: customer.id,
    });
    // CUSTOMER 想放成 1 亿分，被公司层 locked 的 500 万分夹回。
    expect(resolved.value).toBe(5_000_000);
    expect(resolved.clamped).toBe(true);
    expect(resolved.source.scopeType).toBe("COMPANY");
    expect(resolved.source.locked).toBe(true);
  }, 20_000);

  it("PERSON 层放大 reprice_escalation_pct → 被公司层 locked 边界夹回", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const personId = "sales-lina";

    await kernel.pricing.create(
      {
        scopeType: "COMPANY",
        key: "pricing.reprice_escalation_pct",
        value: 5,
        locked: true,
      },
      OWNER,
    );
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
    // PERSON 想放成 100000%，被公司层 locked 的 5% 夹回。
    expect(resolved.value).toBe(5);
    expect(resolved.clamped).toBe(true);
    expect(resolved.source.scopeType).toBe("COMPANY");
  }, 20_000);

  it("reprice_escalation_amount 同样只被 locked 的公司层夹取", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);
    const customer = await kernel.customers.create(
      { code: `PC-C-${id}`, name: "改价金额客户" },
      OWNER,
    );

    await kernel.pricing.create(
      {
        scopeType: "COMPANY",
        key: "pricing.reprice_escalation_amount",
        value: 1_000_000,
        locked: true,
      },
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
    // CUSTOMER 想放成 1 亿分，被公司层 locked 的 100 万分夹回。
    expect(resolved.value).toBe(1_000_000);
    expect(resolved.clamped).toBe(true);
    expect(resolved.source.scopeType).toBe("COMPANY");
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

  it("无任何策略时系统推荐值作为默认生效值，且不参与夹取", async (ctx) => {
    if (!available) ctx.skip();
    const id = suffix();
    const kernel = await tenantKernel(id);

    const resolved = await kernel.pricing.resolve("approval.sales.limit", {});
    // 没有 applicable 策略行 → 落到系统推荐值 500 万分，来源 SYSTEM_DEFAULT。
    expect(resolved.value).toBe(5_000_000);
    expect(resolved.source.kind).toBe("SYSTEM_DEFAULT");
    expect(resolved.clamped).toBe(false);

    const ownerLimit = await kernel.pricing.resolve("approval.owner.limit", {});
    expect(ownerLimit.value).toBeNull();
    expect(ownerLimit.source.kind).toBe("SYSTEM_DEFAULT");
  }, 20_000);
});
