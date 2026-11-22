import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, openTenantSession } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";

/**
 * 成分配比的真实 PG 契约。
 *
 * 覆盖四件事：
 * 1. 配比落库，成分文本由服务端派生（客户端写的文本不作数）；
 * 2. 合计不到 100% 会被拒 —— 成分标注是合规项，不许半截；
 * 3. 文本模式与配比模式互斥：改回文本会把配比清掉；
 * 4. 原料选项合并时，配比与文本一起改写，比例守恒。
 */
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const APP_URL =
  process.env.APP_DATABASE_URL ?? "postgres://weave_app:weave_app@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "composition-bootstrap" } };
const OWNER: KernelContext = { actor: { type: "HUMAN", id: "composition-owner", role: "OWNER" } };

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
    await ownerPool.query("DELETE FROM field_options WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
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
    { slug: `composition-${label}-${suffix()}`, name: `Composition IT ${label}`, casdoorOrg: `org-${label}` },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  return tenant.id;
}

async function tenantKernel(tenantId: string) {
  const session = await openTenantSession(appPool, tenantId);
  return { session, kernel: createKernel(session.db, undefined, { tenantId }) };
}

const COTTON = { code: "MAT-COTTON", percent: 55 };
const LINEN = { code: "MAT-LINEN", percent: 45 };

describe("成分配比：数值 + 原料成对落库", () => {
  it("配比写入后，成分文本由服务端派生并按比例降序", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("store");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const sample = await kernel.samples.create(
        {
          code: `COMP-${suffix()}`,
          name: "棉麻交织布",
          compositionParts: [COTTON, LINEN],
          unit: "meter",
        },
        OWNER,
      );
      expect(sample.composition).toBe("55% 棉 45% 亚麻");
      expect(sample.compositionParts).toEqual([
        { code: "MAT-COTTON", label: "棉", percent: 55 },
        { code: "MAT-LINEN", label: "亚麻", percent: 45 },
      ]);
    } finally {
      await session.release();
    }
  });

  it("客户端写的文本不作数：给了配比就以配比为准", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("derive");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const sample = await kernel.samples.create(
        {
          code: `COMP-${suffix()}`,
          name: "文本与配比同时给",
          composition: "随便写的一串",
          compositionParts: [COTTON, LINEN],
          unit: "meter",
        },
        OWNER,
      );
      expect(sample.composition).toBe("55% 棉 45% 亚麻");
    } finally {
      await session.release();
    }
  });

  it("合计不到 100% 会被拒：成分标注是合规项", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("sum");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await expect(
        kernel.samples.create(
          {
            code: `COMP-${suffix()}`,
            name: "半截配比",
            compositionParts: [{ code: "MAT-COTTON", percent: 55 }],
            unit: "meter",
          },
          OWNER,
        ),
      ).rejects.toThrow(/100%/);
    } finally {
      await session.release();
    }
  });

  it("字典里没有的原料会被拒：不塞来路不明的原料名", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("unknown");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await expect(
        kernel.samples.create(
          {
            code: `COMP-${suffix()}`,
            name: "自造原料",
            compositionParts: [{ code: "MAT-NOT-EXIST", percent: 100 }],
            unit: "meter",
          },
          OWNER,
        ),
      ).rejects.toThrow(/未知原料/);
    } finally {
      await session.release();
    }
  });

  it("改回文本模式：配比一并清空，两种模式不同时为真", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("textmode");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const created = await kernel.samples.create(
        {
          code: `COMP-${suffix()}`,
          name: "先配比后改文本",
          compositionParts: [COTTON, LINEN],
          unit: "meter",
        },
        OWNER,
      );
      const updated = await kernel.samples.update(
        created.id,
        { composition: "供应商给的口头成分" },
        OWNER,
      );
      expect(updated.composition).toBe("供应商给的口头成分");
      expect(updated.compositionParts).toBeNull();
    } finally {
      await session.release();
    }
  });
});

describe("原料字典治理", () => {
  it("原料选项按 code 统计用量", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("usage");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await kernel.samples.create(
        {
          code: `COMP-${suffix()}`,
          name: "用量统计",
          compositionParts: [COTTON, LINEN],
          unit: "meter",
        },
        OWNER,
      );
      const options = await kernel.fieldOptions.listWithUsage("sample.material");
      const cotton = options.find((option) => option.code === "MAT-COTTON");
      expect(cotton?.usage).toBe(1);
      const linen = options.find((option) => option.code === "MAT-LINEN");
      expect(linen?.usage).toBe(1);
    } finally {
      await session.release();
    }
  });

  it("合并原料：配比与文本一起改写，比例守恒", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("merge");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const created = await kernel.samples.create(
        {
          code: `COMP-${suffix()}`,
          name: "合并原料",
          compositionParts: [COTTON, LINEN],
          unit: "meter",
        },
        OWNER,
      );
      // 新建一个同义原料「全棉」，再把「棉」合并进去：
      // 配比里的 code 与文本都要跟着变，比例守恒。
      const alias = await kernel.fieldOptions.create(
        { fieldKey: "sample.material", label: "全棉" },
        OWNER,
      );
      const cottonId = (await kernel.fieldOptions.list("sample.material")).find(
        (option) => option.code === "MAT-COTTON",
      )!.id;
      const preview = await kernel.fieldOptions.previewMerge(cottonId, alias.id);
      expect(preview.affected).toBe(1);

      const merged = await kernel.fieldOptions.merge(
        { sourceId: cottonId, targetId: alias.id, rewriteText: true },
        OWNER,
      );
      expect(merged.affected).toBe(1);

      const after = await kernel.samples.getById(created.id);
      expect(after.compositionParts).toEqual([
        { code: alias.code, label: "全棉", percent: 55 },
        { code: "MAT-LINEN", label: "亚麻", percent: 45 },
      ]);
      expect(after.composition).toBe("55% 全棉 45% 亚麻");
    } finally {
      await session.release();
    }
  });
});
