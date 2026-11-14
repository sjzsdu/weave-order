import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, openTenantSession, sampleImages } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";
import type { AttachSampleImageInput } from "../src/kernel/sample-images.service";

/**
 * sample_images 的数据库契约（真实 PG）：
 * 级联删除、每样品主图唯一、RLS 跨租户隔离。
 *
 * RLS 部分必须用**应用角色**（weave_app，NOBYPASSRLS）连接，owner 会绕过 RLS。
 */
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const APP_URL =
  process.env.APP_DATABASE_URL ?? "postgres://weave_app:weave_app@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "media-it-bootstrap" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "media-it-human" } };

let ownerPool: Pool | null = null;
let appPool: Pool | null = null;
let ownerDb: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  ownerPool = new Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 1500, max: 3 });
  appPool = new Pool({ connectionString: APP_URL, connectionTimeoutMillis: 1500, max: 3 });
  try {
    const probe = await ownerPool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.sample_images') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='weave_app') AS exists",
    );
    available = probe.rows[0]?.exists === true;
    if (available) ownerDb = createDb(OWNER_URL).db;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (ownerPool && available && createdTenants.length > 0) {
    await ownerPool.query("DELETE FROM sample_images WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM sample_embeddings WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM samples WHERE tenant_id = ANY($1::uuid[])", [
      createdTenants,
    ]);
    await ownerPool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
    // audit_log 只追加（触发器禁止 DELETE），测试记录保留。
  }
  await ownerPool?.end();
  await appPool?.end();
});

async function bootstrapTenant(label: string): Promise<string> {
  if (!ownerDb) throw new Error("数据库不可用");
  const kernel = createKernel(ownerDb);
  const tenant = await kernel.tenancy.createTenant(
    { slug: `media-${label}-${suffix()}`, name: `Media IT ${label}`, casdoorOrg: `org-${label}` },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  return tenant.id;
}

async function tenantKernel(tenantId: string) {
  if (!appPool) throw new Error("应用连接池不可用");
  const session = await openTenantSession(appPool, tenantId);
  return { session, kernel: createKernel(session.db, undefined, { tenantId }) };
}

async function newSample(tenantId: string): Promise<string> {
  const { session, kernel } = await tenantKernel(tenantId);
  try {
    const sample = await kernel.samples.create(
      { code: `IT-IMG-${suffix()}`, name: "图片集成测试样品", unit: "meter" },
      HUMAN,
    );
    return sample.id;
  } finally {
    await session.release();
  }
}

function imageInput(
  sampleId: string,
  overrides: Partial<AttachSampleImageInput> = {},
): AttachSampleImageInput {
  return {
    sampleId,
    objectKey: `tenant/${randomUUID()}/samples/${sampleId}/${randomUUID()}.jpg`,
    variant: "primary" as const,
    isPrimary: false,
    mimeType: "image/jpeg",
    byteSize: 2048,
    ...overrides,
  };
}

describe("sample_images 数据库约束", () => {
  it("删除样品后图片行级联删除", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("cascade");
    const sampleId = await newSample(tenantId);
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await kernel.sampleImages.attach(imageInput(sampleId), HUMAN);
    } finally {
      await session.release();
    }
    const before = await ownerPool!.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM sample_images WHERE sample_id = $1",
      [sampleId],
    );
    expect(before.rows[0]?.count).toBe(1);

    await ownerPool!.query("DELETE FROM samples WHERE id = $1", [sampleId]);
    const after = await ownerPool!.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM sample_images WHERE sample_id = $1",
      [sampleId],
    );
    expect(after.rows[0]?.count).toBe(0);
  });

  it("每样品最多一张主图：第二张被数据库拒绝", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("primary");
    const sampleId = await newSample(tenantId);
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await kernel.sampleImages.attach(imageInput(sampleId, { isPrimary: true }), HUMAN);
      await expect(
        kernel.sampleImages.attach(imageInput(sampleId, { isPrimary: true }), HUMAN),
      ).rejects.toMatchObject({ details: { reason: "SAMPLE_PRIMARY_IMAGE_EXISTS" } });
      const images = await kernel.sampleImages.listForSample(sampleId);
      expect(images).toHaveLength(1);
    } finally {
      await session.release();
    }
  });

  it("RLS：租户 A 的会话查不到租户 B 的 sample_images", async (ctx) => {
    if (!available) ctx.skip();
    const tenantA = await bootstrapTenant("rls-a");
    const tenantB = await bootstrapTenant("rls-b");
    const sampleA = await newSample(tenantA);
    const sampleB = await newSample(tenantB);

    const sessionB = await openTenantSession(appPool!, tenantB);
    try {
      const kernelB = createKernel(sessionB.db, undefined, { tenantId: tenantB });
      await kernelB.sampleImages.attach(imageInput(sampleB), HUMAN);
    } finally {
      await sessionB.release();
    }

    const sessionA = await openTenantSession(appPool!, tenantA);
    try {
      // 应用角色直接查表：B 的行被 RLS 过滤掉。
      const visible = await sessionA.db.select().from(sampleImages);
      expect(visible.every((row) => row.tenantId === tenantA)).toBe(true);
      expect(visible).toHaveLength(0);
      // 试图按 B 的 sampleId 读，同样是空。
      const kernelA = createKernel(sessionA.db, undefined, { tenantId: tenantA });
      await expect(kernelA.sampleImages.listForSample(sampleB)).resolves.toEqual([]);
      // 也写不进 B 的样品（归属检查 + RLS 双保险）。
      await expect(kernelA.sampleImages.attach(imageInput(sampleB), HUMAN)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      expect(sampleA).not.toBe(sampleB);
    } finally {
      await sessionA.release();
    }
  });

  it("同一租户同一张图不能重复挂载", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("dupe");
    const sampleId = await newSample(tenantId);
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const input = imageInput(sampleId);
      await kernel.sampleImages.attach(input, HUMAN);
      await expect(kernel.sampleImages.attach(input, HUMAN)).rejects.toMatchObject({
        details: { reason: "SAMPLE_IMAGE_EXISTS" },
      });
    } finally {
      await session.release();
    }
  });

  it("批量取图按 sortOrder 分组", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("list");
    const sampleId = await newSample(tenantId);
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await kernel.sampleImages.attach(imageInput(sampleId, { sortOrder: 5 }), HUMAN);
      await kernel.sampleImages.attach(imageInput(sampleId, { sortOrder: 1 }), HUMAN);
      const grouped = await kernel.sampleImages.listForSampleIds([sampleId, randomUUID()]);
      const rows = grouped.get(sampleId) ?? [];
      expect(rows.map((row) => row.sortOrder)).toEqual([1, 5]);
      // 顺带确认表里存的只有 key，没有 URL。
      expect(rows.every((row) => row.objectKey.startsWith("tenant/"))).toBe(true);
      const raw = await ownerPool!.query<{ object_key: string }>(
        "SELECT object_key FROM sample_images WHERE sample_id = $1",
        [sampleId],
      );
      expect(raw.rows.every((row) => !row.object_key.includes("://"))).toBe(true);
    } finally {
      await session.release();
    }
  });
});
