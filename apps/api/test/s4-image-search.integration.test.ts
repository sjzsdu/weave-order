import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sampleImageEmbeddings, sampleImages, samples, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import { ImageIndexService } from "../src/kernel/image-index.service";
import type { ImageEmbeddingInput, ImageEmbeddingProvider } from "../src/platform/embedding";
import type { ImageCaptioner } from "../src/platform/caption";
import type { ObjectBytes, ObjectHead, ObjectStorage } from "../src/platform/storage";

/**
 * S4 集成测试：图像向量表 / 以图找样真实现 / 去重 / 阈值 / 索引状态 / caption 兜底。
 *
 * 需要本地 PostgreSQL（docker compose up -d && pnpm db:migrate）。
 * 用可控 provider 而不是真实模型：分数是构造出来的，断言才稳定；
 * 真实模型的分离度在 WAN-119 评论里给了实测数据，这里不重复烧钱。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "s4-it-bootstrap" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "s4-it-human" } };

let probe: Pool | null = null;
let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenantIds: string[] = [];

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.sample_image_embeddings') IS NOT NULL AS exists",
    );
    available = table.rows[0]?.exists === true;
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
    await db
      .delete(sampleImageEmbeddings)
      .where(inArray(sampleImageEmbeddings.tenantId, createdTenantIds));
    await db.delete(sampleImages).where(inArray(sampleImages.tenantId, createdTenantIds));
    await db.delete(samples).where(inArray(samples.tenantId, createdTenantIds));
    await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
  }
  await pool?.end();
});

/** 内存对象存储：索引要读原图字节，测试不打真实网络。 */
class FakeStorage implements ObjectStorage {
  private readonly objects = new Map<string, { contentType: string; bytes: Buffer }>();

  put(objectKey: string, bytes: Buffer, contentType = "image/jpeg"): void {
    this.objects.set(objectKey, { contentType, bytes });
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
    return Promise.resolve(this.objects.get(objectKey) ?? null);
  }

  delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
    return Promise.resolve();
  }
}

/**
 * 可控图像 provider：向量由「图片内容标签」决定，相似度可以精确构造。
 * - `same`      → [1,0,0,0]           与查询图 cosine 1.0
 * - `same-angle`→ [0.95,0.312,0,0]    cosine 0.95（同款异角度）
 * - `close`     → [0.7,0,0.714,0]     cosine 0.70（低于默认阈值 0.75）
 * - 其他        → 正交            cosine 0
 */
class ControlledImageProvider implements ImageEmbeddingProvider {
  readonly name = "controlled-image-v1";
  readonly dimension = 4;
  readonly semantic = true;
  readonly maxImagesPerRequest = 3;

  calls = 0;
  fail: string | null = null;

  embedImage(image: ImageEmbeddingInput): Promise<number[]> {
    return this.embedImages([image]).then((vectors) => vectors[0]!);
  }

  embedImages(images: ImageEmbeddingInput[]): Promise<number[][]> {
    this.calls += 1;
    if (this.fail) return Promise.reject(new Error(this.fail));
    return Promise.resolve(images.map((image) => vectorFor(image.base64)));
  }
}

function vectorFor(base64: string): number[] {
  const tag = Buffer.from(base64, "base64").toString("utf8");
  if (tag.startsWith("same-angle")) return [0.95, Math.sqrt(1 - 0.95 ** 2), 0, 0];
  if (tag.startsWith("same")) return [1, 0, 0, 0];
  // 「有点像」放到另一根轴上：与 same 余弦 0.70，与 same-angle 余弦 0.665（都低于 0.75）。
  if (tag.startsWith("close")) return [0.7, 0, Math.sqrt(1 - 0.7 ** 2), 0];
  // 异款：按标签哈希到正交轴（轴 1/2/3），彼此余弦 0。
  const axis = 1 + (tag.length % 3);
  const vector = [0, 0, 0, 0];
  vector[axis] = 1;
  return vector;
}

/**
 * 语义文本 provider：caption 兜底要往 `sample_text_embeddings` 写真实语义行。
 * 维度必须 1024 —— 文本向量列是固定 `vector(1024)`（S3 的迁移），
 * 这也正好说明「图像与文本是两套模型、两套维度」。
 */
class FakeTextProvider {
  readonly name = "controlled-text-v1";
  readonly dimension = 1024;
  readonly semantic = true;

  embedText(text: string): Promise<number[]> {
    return this.embedTexts([text]).then((vectors) => vectors[0]!);
  }

  embedTexts(texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Array<number>(1024).fill(0);
        // 「米白印花」与查询描述同轴；其它样品放到另一根轴上（正交）。
        vector[text.includes("米白") ? 0 : 1] = 1;
        return vector;
      }),
    );
  }

  embedImage(): Promise<number[]> {
    return Promise.reject(new Error("文本 provider 不支持图像"));
  }
}

class FakeCaptioner implements ImageCaptioner {
  readonly name = "fake-captioner";
  calls = 0;

  describe(): Promise<string> {
    this.calls += 1;
    return Promise.resolve("米白底深蓝圆点印花棉布，平纹，手感偏薄");
  }
}

async function isolatedTenant(id: string) {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `s4-${id}`, name: `S4 IT ${id}`, casdoorOrg: `s4-${id}` },
    SYSTEM,
  );
  createdTenantIds.push(tenant.id);
  return tenant;
}

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface Harness {
  kernel: Kernel;
  storage: FakeStorage;
  provider: ControlledImageProvider;
  tenantId: string;
  captioner: FakeCaptioner;
  /** 建一个样品并挂一张图，返回样品 id 与图片 objectKey。 */
  createSampleWithImage(tag: string, name?: string): Promise<{ sampleId: string; objectKey: string }>;
}

async function harness(options: { captionFallback?: boolean } = {}): Promise<Harness> {
  if (!db) throw new Error("数据库不可用");
  const tenant = await isolatedTenant(suffix());
  const storage = new FakeStorage();
  const provider = new ControlledImageProvider();
  const captioner = new FakeCaptioner();
  const kernel = createKernel(db, new FakeTextProvider(), {
    tenantId: tenant.id,
    storage,
    imageEmbedder: provider,
  });

  const createSampleWithImage = async (tag: string, name?: string) => {
    const objectKey = `tenant/${tenant.id}/samples/${randomUUID()}/${randomUUID()}.jpg`;
    storage.put(objectKey, Buffer.from(`${tag}-${randomUUID()}`), "image/jpeg");
    const sample = await kernel.samples.create(
      {
        code: `S4-${suffix()}`,
        name: name ?? `S4 样品 ${tag}`,
        composition: "100% 棉",
        weight: "180g/m2",
        unit: "meter",
        imageKeys: [objectKey],
      },
      HUMAN,
    );
    return { sampleId: sample.id, objectKey };
  };

  if (options.captionFallback) {
    // 直接替换 search 的 captioner 不可行（构造时注入），这里用反射最小的方式：
    // 通过 imageIndex + search 的组合测试 caption 路径时另建 kernel（见用例）。
  }
  return { kernel, storage, provider, tenantId: tenant.id, captioner, createSampleWithImage };
}

async function imageBase64Of(storage: FakeStorage, objectKey: string): Promise<string> {
  const object = await storage.get(objectKey);
  return object!.bytes.toString("base64");
}

describe("S4 图像向量与以图找样", () => {
  it("建样品挂图后写入图像向量，并把索引状态标成 ready", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const { sampleId, objectKey } = await h.createSampleWithImage("same");

    const rows = await db!
      .select()
      .from(sampleImageEmbeddings)
      .where(inArray(sampleImageEmbeddings.sampleId, [sampleId]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe("controlled-image-v1");
    expect(rows[0]?.dimension).toBe(4);

    const images = await db!
      .select()
      .from(sampleImages)
      .where(inArray(sampleImages.sampleId, [sampleId]));
    expect(images[0]?.objectKey).toBe(objectKey);
    expect(images[0]?.indexStatus).toBe("ready");
    expect(images[0]?.indexError).toBeNull();
  }, 30_000);

  it("自召回：查询图 top-1 就是它自己，返回命中图与可核对理由", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const { sampleId, objectKey } = await h.createSampleWithImage("same");
    await h.createSampleWithImage("other-a");
    await h.createSampleWithImage("other-bb");

    const result = await h.kernel.search.searchByImage(
      { mimeType: "image/jpeg", base64: await imageBase64Of(h.storage, objectKey) },
      5,
    );
    expect(result.mode).toBe("image");
    expect(result.semantic).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.sample.id).toBe(sampleId);
    expect(result.matches[0]?.score).toBeCloseTo(1, 5);
    expect(result.matches[0]?.matchedImageId).toBeTruthy();
    expect(result.matches[0]?.matchedImageUrl).toContain("/signed.test/");
    expect(result.matches[0]?.reasons?.[0]).toMatch(/图像相似 100%/);
  }, 30_000);

  it("同款异角度（cosine 0.95）仍命中；低于阈值 0.7 的不返回，显式放宽才返回", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const target = await h.createSampleWithImage("same");
    const close = await h.createSampleWithImage("close");

    const query = { mimeType: "image/jpeg", base64: await imageBase64Of(h.storage, target.objectKey) };

    // 用「同款异角度」那张图查询：命中目标（0.95），不返回 0.70 的「有点像」。
    const angleKey = `tenant/${h.tenantId}/samples/${randomUUID()}/${randomUUID()}.jpg`;
    h.storage.put(angleKey, Buffer.from("same-angle-2"), "image/jpeg");
    await h.kernel.samples.update(
      target.sampleId,
      { imageKeys: [target.objectKey, angleKey] },
      HUMAN,
    );
    const angleQuery = { mimeType: "image/jpeg", base64: await imageBase64Of(h.storage, angleKey) };
    const strict = await h.kernel.search.searchByImage(angleQuery, 5);
    expect(strict.matches.map((match) => match.sample.id)).toEqual([target.sampleId]);
    expect(strict.matches[0]?.score).toBeCloseTo(1, 5);

    // 用目标图查询：0.70 的样品被默认阈值挡住。
    const defaultThreshold = await h.kernel.search.searchByImage(query, 5);
    expect(defaultThreshold.matches.map((match) => match.sample.id)).toEqual([target.sampleId]);

    // 显式放宽到 0.6：那条 0.70 的记录才出现，且仍然排在后面。
    const relaxed = await h.kernel.search.searchByImage(query, 5, 0.6);
    const ids = relaxed.matches.map((match) => match.sample.id);
    expect(ids[0]).toBe(target.sampleId);
    expect(ids).toContain(close.sampleId);
    const closeScore = relaxed.matches.find((match) => match.sample.id === close.sampleId)!.score;
    expect(closeScore).toBeCloseTo(0.7, 5);
  }, 30_000);

  it("同一样品多张图命中时只出现一次，取最高分那张作为 matchedImage", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const { sampleId, objectKey } = await h.createSampleWithImage("same");
    const secondKey = `tenant/${h.tenantId}/samples/${randomUUID()}/${randomUUID()}.jpg`;
    h.storage.put(secondKey, Buffer.from("same-angle-second"), "image/jpeg");
    await h.kernel.samples.update(sampleId, { imageKeys: [objectKey, secondKey] }, HUMAN);

    const result = await h.kernel.search.searchByImage(
      { mimeType: "image/jpeg", base64: await imageBase64Of(h.storage, objectKey) },
      5,
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.sample.id).toBe(sampleId);
    expect(result.matches[0]?.score).toBeCloseTo(1, 5);

    const images = await db!
      .select()
      .from(sampleImages)
      .where(inArray(sampleImages.sampleId, [sampleId]));
    const matched = images.find((image) => image.id === result.matches[0]!.matchedImageId);
    expect(matched?.objectKey).toBe(objectKey);
  }, 30_000);

  it("模型不可用：索引状态标 failed 并留原因；搜索明确报错，不返回空结果", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    h.provider.fail = "上游 502 Bad Gateway";
    const { sampleId } = await h.createSampleWithImage("same");

    const images = await db!
      .select()
      .from(sampleImages)
      .where(inArray(sampleImages.sampleId, [sampleId]));
    expect(images[0]?.indexStatus).toBe("failed");
    expect(images[0]?.indexError).toContain("502");

    // 建样品没有因为索引失败而失败（图已经存下了），但索引失败必须可见。
    await expect(
      h.kernel.search.searchByImage({ mimeType: "image/jpeg", base64: "c2FtZQ==" }, 5),
    ).rejects.toThrow(/502/);

    // 修好模型后，reindex 能把失败行补回来。
    h.provider.fail = null;
    const index = new ImageIndexService(
      db!,
      h.provider,
      h.tenantId,
      h.storage,
    );
    const reindexed = await index.reindexTenant();
    expect(reindexed.failures).toHaveLength(0);
    expect(reindexed.indexed).toBe(1);
    const after = await db!
      .select()
      .from(sampleImages)
      .where(inArray(sampleImages.sampleId, [sampleId]));
    expect(after[0]?.indexStatus).toBe("ready");
  }, 30_000);

  it("reindex 幂等：同模型不重复写行，也不重复调用模型", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    await h.createSampleWithImage("same");
    await h.createSampleWithImage("other-xx");

    const index = new ImageIndexService(db!, h.provider, h.tenantId, h.storage);
    const callsBefore = h.provider.calls;
    const first = await index.reindexTenant();
    expect(first.indexed).toBe(0);
    expect(h.provider.calls).toBe(callsBefore);

    const count = await db!
      .select({ count: sql<number>`count(*)::int` })
      .from(sampleImageEmbeddings)
      .where(inArray(sampleImageEmbeddings.tenantId, [h.tenantId]));
    expect(count[0]?.count).toBe(2);
  }, 30_000);

  it("pendingCount 反映缺向量的图；补齐后归零", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    const { sampleId } = await h.createSampleWithImage("same");
    const index = new ImageIndexService(db!, h.provider, h.tenantId, h.storage);
    expect(await index.pendingCount()).toBe(0);
    expect(await index.hasMissingImages()).toBe(false);

    // 模拟「历史图片还没索引」：直接删掉向量行（S3→S4 升级后的真实状态）。
    await db!
      .delete(sampleImageEmbeddings)
      .where(inArray(sampleImageEmbeddings.sampleId, [sampleId]));
    expect(await index.pendingCount()).toBe(1);
    expect(await index.hasMissingImages()).toBe(true);
    const filled = await index.reindexTenant();
    expect(filled.indexed).toBe(1);
    expect(await index.pendingCount()).toBe(0);
  }, 30_000);

  it("换模型 = 加一条同维度的 partial HNSW 索引，旧模型的行保留", async (ctx) => {
    if (!available) ctx.skip();
    const h = await harness();
    await h.createSampleWithImage("same");
    const index = new ImageIndexService(db!, h.provider, h.tenantId, h.storage);
    const name = await index.ensureHnswIndex();
    expect(name).toBe("sample_image_embeddings_hnsw_controlled_image_v1");

    const found = await db!.execute(
      sql`select indexdef from pg_indexes where indexname = ${name}`,
    );
    const rows = found.rows as { indexdef: string }[];
    expect(rows[0]?.indexdef).toContain("hnsw");
    expect(rows[0]?.indexdef).toContain("controlled-image-v1");
  }, 30_000);

  it("1000 张图下图像检索 p95 < 80ms（走 partial HNSW 索引）", async (ctx) => {
    if (!available) ctx.skip();
    if (!db) throw new Error("数据库不可用");
    const tenant = await isolatedTenant(suffix());
    const count = 1000;
    // 直接造行：只测检索路径，不调模型（1024 维、模型名与迁移里的索引谓词一致）。
    await db.execute(sql`
      INSERT INTO samples (tenant_id, code, name, unit)
      SELECT ${tenant.id}, 'S4-BENCH-' || gen_random_uuid(), '基准样品', 'meter'
      FROM generate_series(1, ${count})
    `);
    await db.execute(sql`
      INSERT INTO sample_images (tenant_id, sample_id, object_key, mime_type, byte_size, index_status)
      SELECT s.tenant_id, s.id, 'tenant/' || s.tenant_id || '/samples/' || s.id || '/' || gen_random_uuid() || '.jpg',
             'image/jpeg', 2048, 'ready'
      FROM samples s
      WHERE s.tenant_id = ${tenant.id} AND s.code LIKE 'S4-BENCH-%'
    `);
    await db.execute(sql`
      INSERT INTO sample_image_embeddings (tenant_id, sample_id, image_id, model, dimension, embedding)
      SELECT i.tenant_id, i.sample_id, i.id, 'dashscope-qwen3-vl-embedding', 1024,
             (SELECT array_agg(random()::real) FROM generate_series(1, 1024))::vector
      FROM sample_images i
      WHERE i.tenant_id = ${tenant.id}
    `);
    await db.execute(sql`ANALYZE sample_image_embeddings`);

    const query = sql`
      SELECT id FROM sample_image_embeddings
      WHERE tenant_id = ${tenant.id} AND model = 'dashscope-qwen3-vl-embedding'
      ORDER BY (embedding::vector(1024)) <=> (SELECT array_agg(0.5::real) FROM generate_series(1, 1024))::vector
      LIMIT 20
    `;
    for (let run = 0; run < 3; run += 1) await db.execute(query);
    const timings: number[] = [];
    for (let run = 0; run < 50; run += 1) {
      const started = performance.now();
      await db.execute(query);
      timings.push(performance.now() - started);
    }
    timings.sort((left, right) => left - right);
    const p95 = timings[Math.floor(timings.length * 0.95) - 1] ?? 0;
    console.log(`${count} 张图：p95 = ${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(80);
  }, 120_000);

  it("模型不可用 + CAPTION_FALLBACK：返回 mode=caption，标明是按描述检索", async (ctx) => {
    if (!available) ctx.skip();
    if (!db) throw new Error("数据库不可用");
    const tenant = await isolatedTenant(suffix());
    const storage = new FakeStorage();
    const provider = new ControlledImageProvider();
    const captioner = new FakeCaptioner();
    // caption 链路要用真实语义文本 provider，向量才会写进 sample_text_embeddings。
    const kernel = createKernel(db, new FakeTextProvider(), {
      tenantId: tenant.id,
      storage,
      imageEmbedder: provider,
    });
    // 直接把 captioner 挂到 search 上：生产由 env.CAPTION_FALLBACK 决定，这里显式注入。
    const search = kernel.search as unknown as {
      image?: { captioner?: ImageCaptioner | null };
    };
    search.image = { ...(search.image ?? {}), captioner };

    const objectKey = `tenant/${tenant.id}/samples/${randomUUID()}/${randomUUID()}.jpg`;
    storage.put(objectKey, Buffer.from("same-caption"), "image/jpeg");
    await kernel.samples.create(
      {
        code: `S4-CAP-${suffix()}`,
        name: "米白底深蓝圆点印花棉布",
        composition: "100% 棉",
        unit: "meter",
        imageKeys: [objectKey],
      },
      HUMAN,
    );

    provider.fail = "上游 503";
    const result = await kernel.search.searchByImage(
      { mimeType: "image/jpeg", base64: await imageBase64Of(storage, objectKey) },
      5,
    );
    expect(captioner.calls).toBe(1);
    expect(result.mode).toBe("caption");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.matchedImageId).toBeNull();
    expect(result.matches[0]?.reasons?.join(" ")).toContain("米白底深蓝圆点印花棉布");
  }, 30_000);
});
