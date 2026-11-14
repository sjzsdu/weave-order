import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sampleImages, samples, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import sharp from "sharp";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import { MediaMaintenanceService } from "../src/kernel/media-maintenance.service";
import { MediaService } from "../src/media/media.service";
import { loadEnv } from "../src/platform/env";
import { thumbObjectKey } from "../src/platform/thumbnail";
import type { ImageEmbeddingProvider } from "../src/platform/embedding";
import type {
  ObjectBytes,
  ObjectHead,
  ObjectStorage,
  StorageObject,
} from "../src/platform/storage";

/**
 * WAN-125 集成测试：派生落盘 / 失败回退标注 / 幂等 / 存量治理 / 孤儿回收。
 *
 * 需要本地 PostgreSQL（docker compose up -d && pnpm db:migrate）。
 * 对象存储用内存实现，但派生用的是生产同一套 sharp 逻辑与 key 规则。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "thumb-it-bootstrap" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "thumb-it-human" } };

const env = loadEnv({
  ...process.env,
  NODE_ENV: "test",
  AUTH_MODE: "dev",
  MEDIA_BASE_URL: "https://cdn.test/weave-media",
});

/** 4 维可控 provider：不碰外部模型，也不解码图片（maxEdge=0）。 */
class FakeImageProvider implements ImageEmbeddingProvider {
  readonly name = "thumb-it-image-v1";
  readonly dimension = 4;
  readonly semantic = true;
  readonly maxImagesPerRequest = 10;

  embedImage(): Promise<number[]> {
    return Promise.resolve([1, 0, 0, 0]);
  }

  embedImages(images: { mimeType: string; base64: string }[]): Promise<number[][]> {
    return Promise.resolve(images.map(() => [1, 0, 0, 0]));
  }
}

class MemoryStorage implements ObjectStorage {
  private readonly objects = new Map<
    string,
    { contentType: string; bytes: Buffer; lastModified: Date }
  >();
  putCalls = 0;

  seed(
    objectKey: string,
    bytes: Buffer,
    contentType = "image/jpeg",
    lastModified = new Date(),
  ): void {
    this.objects.set(objectKey, { contentType, bytes, lastModified });
  }

  read(objectKey: string): Buffer | undefined {
    return this.objects.get(objectKey)?.bytes;
  }

  has(objectKey: string): boolean {
    return this.objects.has(objectKey);
  }

  put(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    this.putCalls += 1;
    this.objects.set(objectKey, { contentType, bytes, lastModified: new Date() });
    return Promise.resolve();
  }

  presignPut(): Promise<string> {
    return Promise.resolve("https://s3.test/upload");
  }

  signGet(objectKey: string): Promise<string> {
    return Promise.resolve(`https://signed.test/${objectKey}`);
  }

  head(objectKey: string): Promise<ObjectHead | null> {
    const object = this.objects.get(objectKey);
    return Promise.resolve(
      object ? { contentType: object.contentType, contentLength: object.bytes.length } : null,
    );
  }

  get(objectKey: string): Promise<ObjectBytes | null> {
    const object = this.objects.get(objectKey);
    return Promise.resolve(
      object ? { contentType: object.contentType, bytes: object.bytes } : null,
    );
  }

  delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
    return Promise.resolve();
  }

  list(prefix: string): Promise<StorageObject[]> {
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({
          key,
          size: object.bytes.length,
          lastModified: object.lastModified,
        })),
    );
  }
}

let probe: Pool | null = null;
let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenantIds: string[] = [];
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, max: 2 });
  try {
    const table = await probe.query<{ ready: boolean }>(
      `SELECT to_regclass('public.sample_images') IS NOT NULL
         AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='sample_images' AND column_name='thumb_status') AS ready`,
    );
    available = table.rows[0]?.ready === true;
    if (available) {
      const handle = createDb(DATABASE_URL);
      db = handle.db;
      pool = handle.pool;
    }
  } catch {
    available = false;
  } finally {
    await probe.end();
    probe = null;
  }
}, 30_000);

afterAll(async () => {
  if (db && createdTenantIds.length > 0) {
    await db.delete(sampleImages).where(inArray(sampleImages.tenantId, createdTenantIds));
    await db.delete(samples).where(inArray(samples.tenantId, createdTenantIds));
    await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
  }
  await pool?.end();
});

async function jpeg(width = 1200, height = 900): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 130, g: 100, b: 80 } },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

interface Harness {
  kernel: Kernel;
  storage: MemoryStorage;
  media: MediaService;
  tenantId: string;
  sampleId: string;
  createImage(bytes?: Buffer): Promise<{ imageId: string; objectKey: string }>;
}

async function harness(): Promise<Harness> {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `thumb-${suffix()}`, name: `缩略图 IT ${suffix()}`, casdoorOrg: `thumb-${suffix()}` },
    SYSTEM,
  );
  createdTenantIds.push(tenant.id);
  const storage = new MemoryStorage();
  const kernel = createKernel(db, undefined, {
    tenantId: tenant.id,
    storage,
    imageEmbedder: new FakeImageProvider(),
    imageEmbeddingMaxEdge: 0,
  });
  const media = new MediaService(storage, env);
  const sample = await kernel.samples.create(
    { code: `THUMB-${suffix()}`, name: "缩略图测试样品", unit: "meter" },
    HUMAN,
  );

  const createImage = async (bytes?: Buffer) => {
    const payload = bytes ?? (await jpeg());
    const objectKey = `tenant/${tenant.id}/samples/${sample.id}/${randomUUID()}.jpg`;
    storage.seed(objectKey, payload, "image/jpeg");
    const { image } = await media.confirm(kernel, HUMAN, {
      objectKey,
      width: 1200,
      height: 900,
    });
    return { imageId: image.id, objectKey };
  };

  return { kernel, storage, media, tenantId: tenant.id, sampleId: sample.id, createImage };
}

async function rowOf(imageId: string) {
  if (!db) throw new Error("数据库不可用");
  const rows = await db.select().from(sampleImages).where(eq(sampleImages.id, imageId));
  const row = rows[0];
  if (!row) throw new Error(`图片不存在：${imageId}`);
  return row;
}

describe("服务端缩略图派生（WAN-125）", () => {
  it("confirm 后派生 320/640 两档 webp，DB 只存 key", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const { imageId } = await h.createImage();
    const row = await rowOf(imageId);

    const expected320 = thumbObjectKey(h.tenantId, h.sampleId, imageId, 320);
    const expected640 = thumbObjectKey(h.tenantId, h.sampleId, imageId, 640);
    expect(row.thumbStatus).toBe("ready");
    expect(row.thumbError).toBeNull();
    expect(row.thumb320Key).toBe(expected320);
    expect(row.thumb640Key).toBe(expected640);
    // key 里只有 id/租户，不含桶域名；DB 不存 URL。
    expect(row.thumb320Key).not.toContain("http");

    const thumb320 = h.storage.read(expected320);
    const thumb640 = h.storage.read(expected640);
    if (!thumb320 || !thumb640) throw new Error("缩略图对象不存在");
    const meta320 = await sharp(thumb320).metadata();
    const meta640 = await sharp(thumb640).metadata();
    expect(meta320.format).toBe("webp");
    expect(meta640.format).toBe("webp");
    expect(meta320.width).toBe(320);
    expect(meta640.width).toBe(640);
    expect(h.storage.read(row.objectKey)!.length).toBe(row.byteSize);

    const presented = await h.media.present(row);
    expect(presented.thumbStatus).toBe("ready");
    expect(presented.thumbUrl).toBe(`https://cdn.test/weave-media/${expected320}`);
    expect(presented.detailUrl).toBe(`https://cdn.test/weave-media/${expected640}`);
    expect(presented.url).toContain(row.objectKey);
  }, 30_000);

  it("派生失败：状态 failed、错误落库，读模型回退原图并标注", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    // confirm 的 HEAD 只校验体积；这里刻意放不可解码的字节。
    const { imageId } = await h.createImage(Buffer.from("definitely-not-an-image"));
    const row = await rowOf(imageId);

    expect(row.thumbStatus).toBe("failed");
    expect(row.thumbError).toContain("无法解码");
    expect(row.thumb320Key).toBeNull();

    const presented = await h.media.present(row);
    expect(presented.thumbStatus).toBe("failed");
    expect(presented.thumbError).not.toBeNull();
    // 回退原图：URL 必须指向原对象，而非不存在的缩略图 key。
    expect(presented.thumbUrl).toBe(`https://cdn.test/weave-media/${row.objectKey}`);
    expect(presented.detailUrl).toBeNull();
  }, 30_000);

  it("重复派生幂等：ready 直接跳过，force 才重写", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const { imageId } = await h.createImage();
    const putsAfterFirst = h.storage.putCalls;

    await expect(h.kernel.thumbs.derive(imageId)).resolves.toBe("unchanged");
    expect(h.storage.putCalls).toBe(putsAfterFirst);

    await expect(h.kernel.thumbs.derive(imageId, { force: true })).resolves.toBe("ready");
    expect(h.storage.putCalls).toBe(putsAfterFirst + 2);
    expect((await rowOf(imageId)).thumbStatus).toBe("ready");
  }, 30_000);

  it("存量补派生：干跑不写，执行后幂等（再跑 0 条）", async (ctx) => {
    if (!available) ctx.skip();
    if (!db) throw new Error("数据库不可用");
    const h = await harness();
    // 直接插一行 pending（模拟 0016 之前入库的历史图片），对象存在可以派生。
    const objectKey = `tenant/${h.tenantId}/samples/${h.sampleId}/${randomUUID()}.jpg`;
    const bytes = await jpeg();
    h.storage.seed(objectKey, bytes, "image/jpeg");
    const imageId = randomUUID();
    await db.insert(sampleImages).values({
      id: imageId,
      tenantId: h.tenantId,
      sampleId: h.sampleId,
      objectKey,
      variant: "primary",
      isPrimary: false,
      mimeType: "image/jpeg",
      byteSize: bytes.length,
      sortOrder: 1,
    });
    const maintenance = new MediaMaintenanceService(db, h.tenantId, h.storage, h.kernel.thumbs);

    const putsBefore = h.storage.putCalls;
    const dry = await maintenance.backfillThumbs({ dryRun: true });
    expect(dry.pending).toBe(1);
    expect(dry.derived).toBe(0);
    expect(h.storage.putCalls).toBe(putsBefore);
    expect((await rowOf(imageId)).thumbStatus).toBe("pending");

    const real = await maintenance.backfillThumbs();
    expect(real.derived).toBe(1);
    expect((await rowOf(imageId)).thumbStatus).toBe("ready");

    const again = await maintenance.backfillThumbs();
    expect(again.pending).toBe(0);
    expect(again.derived).toBe(0);
    expect(h.storage.putCalls).toBe(putsBefore + 2);
  }, 30_000);

  it("孤儿回收：干跑不删；只删超过保护期且未被 DB 引用的样品对象", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const { objectKey, imageId } = await h.createImage();
    const row = await rowOf(imageId);
    const old = new Date(Date.now() - 48 * 3600_000);
    const orphanOld = `tenant/${h.tenantId}/samples/${h.sampleId}/${randomUUID()}.jpg`;
    const orphanNew = `tenant/${h.tenantId}/samples/${h.sampleId}/${randomUUID()}.jpg`;
    h.storage.seed(orphanOld, Buffer.from("old-orphan"), "image/jpeg", old);
    h.storage.seed(orphanNew, Buffer.from("new-orphan"), "image/jpeg", new Date());
    // 回款凭证不在 samples/ 前缀下，不该被这条任务看见（误删会造成凭证丢失）。
    const receipt = `tenant/${h.tenantId}/receipts/${randomUUID()}/proof.jpg`;
    h.storage.seed(receipt, Buffer.from("receipt"), "image/jpeg", old);

    const maintenance = new MediaMaintenanceService(db!, h.tenantId, h.storage, h.kernel.thumbs);
    const dry = await maintenance.cleanupOrphanedObjects({ dryRun: true, graceHours: 24 });
    expect(dry.candidates).toBe(1);
    expect(dry.deleted).toBe(0);
    expect(h.storage.has(orphanOld)).toBe(true);

    const real = await maintenance.cleanupOrphanedObjects({ graceHours: 24 });
    expect(real.deleted).toBe(1);
    expect(h.storage.has(orphanOld)).toBe(false);
    // 引用中的对象与保护期内的对象都要保留。
    expect(h.storage.has(objectKey)).toBe(true);
    expect(h.storage.has(row.thumb320Key!)).toBe(true);
    expect(h.storage.has(row.thumb640Key!)).toBe(true);
    expect(h.storage.has(orphanNew)).toBe(true);
    expect(h.storage.has(receipt)).toBe(true);

    const again = await maintenance.cleanupOrphanedObjects({ graceHours: 24 });
    expect(again.deleted).toBe(0);
  }, 30_000);

  it("超大原图重编码：干跑不写；执行后体积下降、mime 不变、再跑不重复处理", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const big = await jpeg(1600, 1200);
    const { imageId, objectKey } = await h.createImage(big);
    const maintenance = new MediaMaintenanceService(db!, h.tenantId, h.storage, h.kernel.thumbs);
    // 用 1 字节阈值确保选中（真实阈值 2MB 对测试图太小）。
    const thresholdBytes = 1;

    const bytesBefore = h.storage.read(objectKey)!.length;
    const dry = await maintenance.compressOversizedOriginals({ dryRun: true, thresholdBytes });
    expect(dry.scanned).toBe(1);
    expect(dry.compressed).toBe(1);
    expect(dry.savedBytes).toBeGreaterThan(0);
    expect(h.storage.read(objectKey)!.length).toBe(bytesBefore);
    expect((await rowOf(imageId)).reencodedAt).toBeNull();

    const real = await maintenance.compressOversizedOriginals({ thresholdBytes });
    expect(real.compressed).toBe(1);
    const after = await rowOf(imageId);
    expect(after.byteSize).toBeLessThan(bytesBefore);
    expect(after.mimeType).toBe("image/jpeg");
    expect(after.originalByteSize).toBe(bytesBefore);
    expect(after.reencodedAt).not.toBeNull();
    const stored = h.storage.read(objectKey)!;
    expect(stored.length).toBe(after.byteSize);
    expect((await sharp(stored).metadata()).format).toBe("jpeg");

    const again = await maintenance.compressOversizedOriginals({ thresholdBytes });
    expect(again.scanned).toBe(0);
  }, 30_000);

  it("缩略图 pending 计数与失败状态可被治理任务看见", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    await h.createImage();
    const broken = await h.createImage(Buffer.from("nope"));
    const counts = await h.kernel.thumbs.statusCounts();
    expect(counts.ready).toBeGreaterThanOrEqual(1);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    // 失败行仍是 pending 口径（待派生），补派生会重试。
    expect(await h.kernel.thumbs.pendingImageIds(10)).toContain(broken.imageId);
  }, 30_000);
});
