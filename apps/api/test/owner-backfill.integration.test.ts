import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";
import { applyOwnerBackfill, planOwnerBackfill, rollbackSql } from "../scripts/backfill-owner";
import { ensureDemoIdentity } from "../scripts/demo-identity";

/**
 * 无归属数据（WAN-106）的既定语义（方案 A）：
 *  - `owner_id IS NULL` 对任何 OWN 范围都不可见（含 OWNER，fail-closed 不放宽）；
 *  - 对 ALL 范围可见；
 *  - 历史数据由回填脚本一次性归给租户最早的 ACTIVE OWNER 成员。
 * 智能体替业务员干活时，KernelContext 带业务员的 ownerId，写入即归属该业务员。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "owner-backfill-bootstrap" } };

let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenants: string[] = [];

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const check = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customers') IS NOT NULL AND to_regclass('public.memberships') IS NOT NULL AS exists",
    );
    available = check.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (pool && available && createdTenants.length > 0) {
    await pool.query("DELETE FROM customer_contexts WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await pool.query("DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM memberships WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await pool?.end();
});

describe("无归属客户：可见性语义与回填", () => {
  it("OWN 看不到 NULL；智能体带 ownerId 则归属业务员；回填归给 OWNER", async (ctx) => {
    const database = db;
    const poolInstance = pool;
    if (!available || !database || !poolInstance) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const kernel = createKernel(database);
    const tenant = await kernel.tenancy.createTenant(
      { slug: `own-${id}`, name: `归属 ${id}`, casdoorOrg: `own-${id}` },
      SYSTEM,
    );
    createdTenants.push(tenant.id);
    const scoped = createKernel(database, undefined, { tenantId: tenant.id });

    const owner = await scoped.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `owner-${id}`,
        casdoorOrg: `own-${id}`,
        role: "OWNER",
        dataScope: "ALL",
      },
      SYSTEM,
    );
    const sales = await scoped.tenancy.createMembership(
      {
        tenantId: tenant.id,
        subject: `sales-${id}`,
        casdoorOrg: `own-${id}`,
        role: "SALES",
        dataScope: "OWN",
      },
      SYSTEM,
    );

    const ownerCtx: KernelContext = {
      actor: { type: "HUMAN", id: `owner-subject-${id}`, role: "OWNER" },
      dataScope: "ALL",
      ownerId: owner.id,
      teamId: null,
    };
    const salesCtx: KernelContext = {
      actor: { type: "HUMAN", id: `sales-subject-${id}`, role: "SALES" },
      dataScope: "OWN",
      ownerId: sales.id,
      teamId: null,
    };
    const agentCtx: KernelContext = { actor: { type: "AGENT", id: "quoting-agent" } };
    // 智能体替业务员干活：带上该业务员的 ownerId。
    const agentForSalesCtx: KernelContext = { ...agentCtx, ownerId: sales.id };

    // 历史/系统写入：没有任何归属人。
    const unowned = await scoped.customers.create(
      { code: `OWN-NULL-${id}`, name: "无归属客户" },
      agentCtx,
    );
    const ownedByAgent = await scoped.customers.create(
      { code: `OWN-AGENT-${id}`, name: "智能体代业务员建客户" },
      agentForSalesCtx,
    );

    const ownerRows = await poolInstance.query<{ id: string; owner_id: string | null }>(
      "SELECT id, owner_id FROM customers WHERE id = ANY($1::uuid[])",
      [[unowned.id, ownedByAgent.id]],
    );
    const ownerById = new Map(ownerRows.rows.map((row) => [row.id, row.owner_id]));
    expect(ownerById.get(unowned.id)).toBeNull();
    expect(ownerById.get(ownedByAgent.id)).toBe(sales.id);

    // 方案 A 不改可见性判定：OWN 看 NULL → 空；ALL 看 NULL → 可见。
    expect((await scoped.customers.list(100, salesCtx)).map((row) => row.id)).toEqual([
      ownedByAgent.id,
    ]);
    expect((await scoped.customers.list(100, ownerCtx)).map((row) => row.id).sort()).toEqual(
      [unowned.id, ownedByAgent.id].sort(),
    );
    // 单条读取同样 fail-closed：SALES 读 NULL 与读他人的单据一样按「不存在」处理。
    await expect(scoped.customers.getById(unowned.id, salesCtx)).rejects.toMatchObject({
      code: "CUSTOMER_NOT_FOUND",
    });

    // 只读计划：无归属客户 1 条，目标是租户最早的 ACTIVE OWNER（不是业务员）。
    const plans = await planOwnerBackfill(poolInstance, [tenant.id]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      tenantId: tenant.id,
      ownerMembershipId: owner.id,
      ownerCandidates: 1,
      customerIds: [unowned.id],
    });
    expect(rollbackSql(plans[0]!, new Date().toISOString())).toContain(unowned.id);

    const { updated } = await applyOwnerBackfill(poolInstance, plans);
    expect(updated).toBe(1);

    // 回填后：无归属数据归 OWNER；SALES（OWN）仍然只看自己的客户。
    const after = await poolInstance.query<{ owner_id: string | null }>(
      "SELECT owner_id FROM customers WHERE id = $1",
      [unowned.id],
    );
    expect(after.rows[0]?.owner_id).toBe(owner.id);
    expect((await scoped.customers.list(100, salesCtx)).map((row) => row.id)).toEqual([
      ownedByAgent.id,
    ]);
    expect((await scoped.customers.list(100, ownerCtx)).map((row) => row.id).sort()).toEqual(
      [unowned.id, ownedByAgent.id].sort(),
    );
    expect(await planOwnerBackfill(poolInstance, [tenant.id])).toEqual([]);
  });

  it("seed 身份解析幂等：复用同一对成员，不会重复建号", async (ctx) => {
    const database = db;
    const poolInstance = pool;
    if (!available || !database || !poolInstance) {
      ctx.skip();
      return;
    }
    const id = suffix();
    const kernel = createKernel(database);
    const tenant = await kernel.tenancy.createTenant(
      { slug: `seed-${id}`, name: `Seed ${id}`, casdoorOrg: `seed-${id}` },
      SYSTEM,
    );
    createdTenants.push(tenant.id);

    const previous = process.env.SEED_TENANT_ID;
    process.env.SEED_TENANT_ID = tenant.id;
    try {
      const first = await ensureDemoIdentity(database);
      const second = await ensureDemoIdentity(database);
      expect(second).toEqual(first);

      const membershipsInTenant = await poolInstance.query<{ subject: string; role: string }>(
        "SELECT subject, role FROM memberships WHERE tenant_id = $1 ORDER BY subject",
        [tenant.id],
      );
      expect(membershipsInTenant.rows).toEqual([
        { subject: "demo", role: "OWNER" },
        { subject: "demo-sales", role: "SALES" },
      ]);
    } finally {
      if (previous === undefined) delete process.env.SEED_TENANT_ID;
      else process.env.SEED_TENANT_ID = previous;
    }
  });
});
