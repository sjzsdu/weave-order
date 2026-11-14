import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, openTenantSession } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { KernelContext } from "../src/kernel";
import { isKernelError } from "../src/kernel";
import type { ObjectHead, ObjectStorage } from "../src/platform/storage";

/**
 * 样品 CRUD / 图墙分页 / 图片排序的真实 PG 契约。
 *
 * 对象存储用假实现：只验证「key 归属 + HEAD 元信息」这一段逻辑，
 * 不依赖本地 MinIO 是否在跑（上传链路由 media-upload.test 覆盖）。
 */
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const APP_URL =
  process.env.APP_DATABASE_URL ?? "postgres://weave_app:weave_app@localhost:5433/weave_order";

const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "samples-it-bootstrap" } };
const OWNER: KernelContext = { actor: { type: "HUMAN", id: "samples-it-owner", role: "OWNER" } };
const SALES: KernelContext = { actor: { type: "HUMAN", id: "samples-it-sales", role: "SALES" } };
const VIEWER: KernelContext = {
  actor: { type: "HUMAN", id: "samples-it-viewer", role: "VIEWER" },
};

class FakeStorage implements ObjectStorage {
  readonly heads = new Map<string, ObjectHead>();

  put(objectKey: string, byteSize = 2048, contentType = "image/jpeg"): void {
    this.heads.set(objectKey, { contentType, contentLength: byteSize });
  }

  presignPut(): Promise<string> {
    return Promise.resolve("https://s3.test/upload");
  }

  signGet(objectKey: string): Promise<string> {
    return Promise.resolve(`https://signed.test/${objectKey}`);
  }

  head(objectKey: string): Promise<ObjectHead | null> {
    return Promise.resolve(this.heads.get(objectKey) ?? null);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}

const storage = new FakeStorage();
const appPool = new Pool({ connectionString: APP_URL, connectionTimeoutMillis: 1500, max: 3 });
let ownerPool: Pool | null = null;
let ownerDb: Db | null = null;
let available = false;
const createdTenants: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  ownerPool = new Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 1500, max: 3 });
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
    {
      slug: `samples-${label}-${suffix()}`,
      name: `Samples IT ${label}`,
      casdoorOrg: `org-${label}`,
    },
    SYSTEM,
  );
  createdTenants.push(tenant.id);
  return tenant.id;
}

async function tenantKernel(tenantId: string) {
  const session = await openTenantSession(appPool, tenantId);
  return {
    session,
    kernel: createKernel(session.db, undefined, { tenantId, storage }),
  };
}

function imageKey(tenantId: string, scope: "uploads" | "samples", sampleId?: string): string {
  const folder = scope === "samples" && sampleId ? `samples/${sampleId}` : "uploads";
  return `tenant/${tenantId}/${folder}/${randomUUID()}.jpg`;
}

describe("样品 CRUD 与图墙", () => {
  it("创建返回完整读模型，写审计在账本里", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("create");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const sample = await kernel.samples.create(
        {
          code: `IT-${suffix()}`,
          name: "32S 精梳棉汗布",
          composition: "100% 棉",
          category: "针织",
          weight: "220g/m²",
          unit: "meter",
          costFloor: { amount: 1420, currency: "CNY" },
        },
        OWNER,
      );
      expect(sample.code).toContain("IT-");
      expect(sample.costFloor).toEqual({ amount: 1420, currency: "CNY" });

      const audit = await kernel.audit.list(5, sample.id);
      expect(audit[0]?.action).toBe("SAMPLE_CREATED");
    } finally {
      await session.release();
    }
  });

  it("重复编码拒绝，错误原因是 SAMPLE_CODE_EXISTS", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("dup");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const code = `DUP-${suffix()}`;
      await kernel.samples.create({ code, name: "重复编码样品", unit: "meter" }, OWNER);
      await expect(
        kernel.samples.create({ code, name: "另一个同名编码", unit: "meter" }, OWNER),
      ).rejects.toMatchObject({
        code: "KERNEL_REJECTED",
        details: { reason: "SAMPLE_CODE_EXISTS" },
      });
    } finally {
      await session.release();
    }
  });

  it("sales / viewer 无写权限，sales 读到的成本底线被裁剪", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("roles");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      await expect(
        kernel.samples.create({ code: `R-${suffix()}`, name: "销售不能建", unit: "meter" }, SALES),
      ).rejects.toSatisfy(
        (error: unknown) => isKernelError(error) && error.code === "PERMISSION_DENIED",
      );
      await expect(
        kernel.samples.create({ code: `V-${suffix()}`, name: "访客不能建", unit: "meter" }, VIEWER),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

      const sample = await kernel.samples.create(
        {
          code: `C-${suffix()}`,
          name: "成本可见性",
          unit: "meter",
          costFloor: { amount: 999, currency: "CNY" },
        },
        OWNER,
      );
      await expect(kernel.samples.archive(sample.id, SALES)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      const page = await kernel.samples.listPage({}, SALES);
      expect(page.samples[0]?.costFloor).toBeNull();
      const ownerPage = await kernel.samples.listPage({}, OWNER);
      expect(ownerPage.samples[0]?.costFloor).toEqual({ amount: 999, currency: "CNY" });
    } finally {
      await session.release();
    }
  });

  it("120 个样品时游标分页能取到第 101~120 个（不再被 limit 100 截断）", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("page");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const prefix = `PG-${suffix()}`;
      for (let index = 0; index < 120; index += 1) {
        await kernel.samples.create(
          {
            code: `${prefix}-${String(index + 1).padStart(3, "0")}`,
            name: `分页样品 ${index + 1}`,
            unit: "meter",
          },
          OWNER,
        );
      }
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      let total = 0;
      do {
        const page = await kernel.samples.listPage({ cursor, limit: 50 }, OWNER);
        total = page.total;
        for (const sample of page.samples) {
          expect(seen.has(sample.id)).toBe(false);
          seen.add(sample.id);
        }
        pages += 1;
        cursor = page.nextCursor;
      } while (cursor && pages < 10);
      expect(total).toBe(120);
      expect(seen.size).toBe(120);
      expect(pages).toBe(3);
    } finally {
      await session.release();
    }
  }, 60_000);

  it("图片按 sortOrder 排序，有且仅有一张主图；主图切换不撞唯一索引", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("images");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const sample = await kernel.samples.create(
        { code: `IMG-${suffix()}`, name: "图片排序", unit: "meter" },
        OWNER,
      );
      const keys = [
        imageKey(tenantId, "samples", sample.id),
        imageKey(tenantId, "samples", sample.id),
        imageKey(tenantId, "samples", sample.id),
      ];
      for (const key of keys) storage.put(key);

      await kernel.samples.update(sample.id, { imageKeys: keys, primaryImageKey: keys[0] }, OWNER);
      let rows = await kernel.sampleImages.listForSample(sample.id);
      expect(rows.map((row) => row.objectKey)).toEqual(keys);
      expect(rows.filter((row) => row.isPrimary)).toHaveLength(1);
      expect(rows.find((row) => row.isPrimary)?.objectKey).toBe(keys[0]);

      // 整组倒序 + 换主图：先清后设，不能触发 sample_images_primary_per_sample_idx。
      const reversed = [rows[2]!, rows[1]!, rows[0]!];
      await kernel.samples.update(
        sample.id,
        {
          imageIds: reversed.map((row) => row.id),
          primaryImageId: reversed[0]!.id,
        },
        OWNER,
      );
      rows = await kernel.sampleImages.listForSample(sample.id);
      expect(rows.map((row) => row.objectKey)).toEqual([keys[2], keys[1], keys[0]]);
      expect(rows.filter((row) => row.isPrimary)).toHaveLength(1);
      expect(rows[0]?.isPrimary).toBe(true);

      // 只设主图，不动顺序。
      await kernel.samples.update(sample.id, { primaryImageId: rows[2]!.id }, OWNER);
      rows = await kernel.sampleImages.listForSample(sample.id);
      expect(rows.find((row) => row.isPrimary)?.id).toBe(rows[2]!.id);

      // confirm 直接挂第一张图时必须自动成为主图，移动端「拍照建样」不走 PATCH。
      const fresh = await kernel.samples.create(
        { code: `IMG-FIRST-${suffix()}`, name: "首图即主图", unit: "meter" },
        OWNER,
      );
      const firstKey = imageKey(tenantId, "samples", fresh.id);
      storage.put(firstKey);
      const attached = await kernel.sampleImages.attach(
        {
          sampleId: fresh.id,
          objectKey: firstKey,
          variant: "primary",
          isPrimary: false,
          mimeType: "image/jpeg",
          byteSize: 2048,
        },
        OWNER,
      );
      expect(attached.isPrimary).toBe(true);
    } finally {
      await session.release();
    }
  });

  it("key 不属于本租户时拒绝挂载", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("keyguard");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const foreign = `tenant/${randomUUID()}/uploads/${randomUUID()}.jpg`;
      storage.put(foreign);
      await expect(
        kernel.samples.create(
          { code: `KEY-${suffix()}`, name: "跨租户 key", unit: "meter", imageKeys: [foreign] },
          OWNER,
        ),
      ).rejects.toMatchObject({ code: "KERNEL_REJECTED" });
      const page = await kernel.samples.listPage({ query: `KEY-${suffix()}` }, OWNER);
      expect(page.samples).toHaveLength(0);
    } finally {
      await session.release();
    }
  });

  it("归档是软删：状态变 ARCHIVED，默认列表不再返回", async (ctx) => {
    if (!available) ctx.skip();
    const tenantId = await bootstrapTenant("archive");
    const { session, kernel } = await tenantKernel(tenantId);
    try {
      const sample = await kernel.samples.create(
        { code: `ARC-${suffix()}`, name: "归档样品", unit: "meter" },
        OWNER,
      );
      await kernel.samples.archive(sample.id, OWNER);
      const active = await kernel.samples.listPage({}, OWNER);
      expect(active.samples.find((entry) => entry.id === sample.id)).toBeUndefined();
      const archived = await kernel.samples.listPage({ status: "ARCHIVED" }, OWNER);
      expect(archived.samples.some((entry) => entry.id === sample.id)).toBe(true);
      const audit = await kernel.audit.list(5, sample.id);
      expect(audit[0]?.action).toBe("SAMPLE_ARCHIVED");
    } finally {
      await session.release();
    }
  });
});
