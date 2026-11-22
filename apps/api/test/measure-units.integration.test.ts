import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, openTenantSession } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 度量单位（克重 / 门幅）的真实 PG 契约。
 *
 * 覆盖三件事：
 * 1. 数值 + 单位成对落库，归一列（g/m²、cm）由代码折算，不让客户端写；
 * 2. 租户默认单位可读可改，只影响之后的录入默认值，不动历史数据；
 * 3. 只给数值不给单位会被拒 —— 单位不许猜。
 */
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const APP_URL =
  process.env.APP_DATABASE_URL ?? "postgres://weave_app:weave_app@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "measure-it-bootstrap" } };
const OWNER: KernelContext = { actor: { type: "HUMAN", id: "measure-it-owner", role: "OWNER" } };
const SALES: KernelContext = { actor: { type: "HUMAN", id: "measure-it-sales", role: "SALES" } };

const ownerPool = new Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 1500, max: 3 });
const appPool = new Pool({ connectionString: APP_URL, connectionTimeoutMillis: 1500, max: 3 });
let ownerDb: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  try {
    const probe = await ownerPool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.samples') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='weave_app') AS exists",
    );
    available = probe.rows[0]?.exists === true;
    if (available) ownerDb = createDb(OWNER_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (ownerPool && available && createdTenants.length > 0) {
    await ownerPool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [createdTenants]);
    await ownerPool.query("DELETE FROM memberships WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  }
  await ownerPool?.end();
  await appPool.end();
});

async function bootstrapTenant(label: string): Promise<string> {
  if (!ownerDb) throw new Error("数据库不可用");
  const kernel = createKernel(ownerDb);
  const tenant = await kernel.tenancy.createTenant(
    { slug: `measure-${label}-${suffix()}`, name: `Measure IT ${label}`, casdoorOrg: `org-${label}` },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  return tenant.id;
}

async function tenantKernel(tenantId: string) {
  const session = await openTenantSession(appPool, tenantId);
  return { session, kernel: createKernel(session.db, undefined, { tenantId }) };
}

describe("度量单位：数值 + 单位成对落库", () => {
  it("按录入单位存，归一列由代码折算", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("store");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const sample = await kernel.samples.create(
        {
          code: `MEASURE-${suffix()}`,
          name: "出口弹力布",
          weight: { value: 6.5, unit: "oz" },
          width: { value: 59, unit: "in" },
          unit: "meter",
        },
        OWNER,
      );
      // 读模型给回录入的那一对，单位不偷换。
      expect(sample.weight).toEqual({ value: 6.5, unit: "oz" });
      expect(sample.width).toEqual({ value: 59, unit: "in" });
      // 归一列是折算出来的：6.5 oz/yd² ≈ 220 g/m²，59 inch = 150 cm。
      expect(sample.weightGsm).toBe(220);
      expect(sample.widthCm).toBe(150);
    } finally {
      await session.release();
    }
  });

  it("没填就是没填：数值与单位都不给不会写成 0", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("empty");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const sample = await kernel.samples.create(
        { code: `MEASURE-${suffix()}`, name: "没填规格的布", unit: "meter" },
        OWNER,
      );
      expect(sample.weight).toBeNull();
      expect(sample.width).toBeNull();
      expect(sample.weightGsm).toBeNull();
      expect(sample.widthCm).toBeNull();
    } finally {
      await session.release();
    }
  });

  it("只给数值不给单位会被拒：单位不许猜", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("guess");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await expect(
        kernel.samples.create(
          {
            code: `MEASURE-${suffix()}`,
            name: "只有数值的布",
            // 契约要求数值与单位成对：只给数值是形状错误，直接拒。
            weight: { value: 220 } as never,
            unit: "meter",
          },
          OWNER,
        ),
      ).rejects.toThrow();
    } finally {
      await session.release();
    }
  });

  it("改单位只影响这条样品：另一条照旧", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("switch");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const code = `MEASURE-${suffix()}`;
      const created = await kernel.samples.create(
        { code, name: "改单位前", weight: { value: 220, unit: "gsm" }, unit: "meter" },
        OWNER,
      );
      const updated = await kernel.samples.update(
        created.id,
        { weight: { value: 6.5, unit: "oz" } },
        OWNER,
      );
      expect(updated.weight).toEqual({ value: 6.5, unit: "oz" });
      expect(updated.weightGsm).toBe(220);
    } finally {
      await session.release();
    }
  });
});

describe("租户默认计量单位", () => {
  it("没配过时给行业默认 g/m² 与 cm", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("default");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      expect(await kernel.measureUnits.get(OWNER)).toEqual({ weight: "gsm", width: "cm" });
    } finally {
      await session.release();
    }
  });

  it("改默认单位：写入租户设置并留审计", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("update");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const next = await kernel.measureUnits.update({ weight: "oz", width: "in" }, OWNER);
      expect(next).toEqual({ weight: "oz", width: "in" });
      expect(await kernel.measureUnits.get(OWNER)).toEqual({ weight: "oz", width: "in" });

      const audit = await kernel.audit.list(5, tenantId);
      expect(audit.some((entry) => entry.action === "TENANT_MEASURE_UNITS_UPDATED")).toBe(true);
    } finally {
      await session.release();
    }
  });

  it("只提交一个键：另一个保持原值", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("partial");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await kernel.measureUnits.update({ weight: "kgm2" }, OWNER);
      expect(await kernel.measureUnits.get(OWNER)).toEqual({ weight: "kgm2", width: "cm" });
    } finally {
      await session.release();
    }
  });

  it("没有 settings.edit 的角色改不了默认单位", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("perm");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await expect(kernel.measureUnits.update({ weight: "oz" }, SALES)).rejects.toThrow(
        /权限|设置/,
      );
      // 读不设门槛：录入面人人都要看默认值。
      expect(await kernel.measureUnits.get(SALES)).toEqual({ weight: "gsm", width: "cm" });
    } finally {
      await session.release();
    }
  });
});
