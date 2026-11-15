/**
 * 图墙缩略图验收脚本（WAN-125）。
 *
 * 做什么：
 *   1. 在本地 MinIO 里造 N 张 2400px 大图（真实对象，不是 mock）；
 *   2. 直接落一个临时租户 + 样品 + N 条 sample_images（不碰业务数据，跑完清理）；
 *   3. 用生产同一套 `SampleThumbService` 派生 `_320.webp` / `_640.webp`；
 *   4. 按图墙首屏口径，分别拉「改前：原图 URL」与「改后：thumbUrl」并统计传输字节。
 *
 * 前置：
 *   scripts/dev-storage-up.sh
 *   pnpm db:migrate   # 需要 0016 的 thumb_* 列
 *
 * 用法：
 *   pnpm --filter @weave-order/api verify:thumbnails
 *   pnpm --filter @weave-order/api verify:thumbnails -- --count=50 --keep
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDb, sampleImages, samples, tenants } from "@weave-order/db";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { loadEnv } from "../src/platform/env";
import { createObjectStorageFromEnv } from "../src/platform/storage";
import { MediaService } from "../src/media/media.service";
import { SampleThumbService } from "../src/kernel/sample-thumbs.service";
import { thumbObjectKey } from "../src/platform/thumbnail";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值（本地 MinIO）。
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 生成一张有纹理的大图（纯色会被 JPEG 压到很小，测不出图墙问题）。 */
async function makeFabricJpeg(size: number): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 3;
      const weave = Math.sin(x / 3.1) * Math.cos(y / 4.7);
      const stripe = Math.sin((x + y) / 37) * 0.4;
      raw[offset] = Math.max(0, Math.min(255, 128 + weave * 60 + stripe * 40));
      raw[offset + 1] = Math.max(0, Math.min(255, 118 + weave * 50 - stripe * 30));
      raw[offset + 2] = Math.max(0, Math.min(255, 96 + weave * 40 + stripe * 20));
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function main(): Promise<void> {
  const env = loadEnv();
  const storage = createObjectStorageFromEnv(env);
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
  const count = Number(argValue("count") ?? 50);
  const size = Number(argValue("size") ?? 2400);
  const keep = hasFlag("keep");
  const { db, pool } = createDb(databaseUrl);
  const probe = new Pool({ connectionString: databaseUrl, max: 1 });
  const media = new MediaService(storage, env);

  const suffix = Date.now().toString(36);
  let tenantId: string | null = null;
  let sampleId: string | null = null;

  try {
    // 前置：迁移到 HEAD 且 thumb_* 列存在。
    const migrated = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.sample_images') IS NOT NULL AS exists",
    );
    if (!migrated.rows[0]?.exists) throw new Error("数据库未迁移：先 pnpm db:migrate");
    const columns = await probe.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sample_images' AND column_name='thumb_status') AS exists",
    );
    if (!columns.rows[0]?.exists)
      throw new Error("数据库缺少 thumb_status 列：先 pnpm db:migrate（0016）");

    const tenantRows = await db
      .insert(tenants)
      .values({ slug: `thumb-verify-${suffix}`, name: `缩略图验收 ${suffix}` })
      .returning({ id: tenants.id });
    tenantId = tenantRows[0]!.id;
    const sampleRows = await db
      .insert(samples)
      .values({
        tenantId,
        code: `THUMB-${suffix}`,
        name: "缩略图验收样品",
        unit: "meter",
      })
      .returning({ id: samples.id });
    sampleId = sampleRows[0]!.id;

    console.log(`准备 ${count} 张 ${size}px 图片（租户 ${tenantId}）…`);
    const jpeg = await makeFabricJpeg(size);
    console.log(`单张原图 ${kb(jpeg.length)}，合计 ${mb(jpeg.length * count)}`);

    const imageIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const objectKey = `tenant/${tenantId}/samples/${sampleId}/${randomUUID()}.jpg`;
      await storage.put(objectKey, jpeg, "image/jpeg");
      const imageId = randomUUID();
      await db.insert(sampleImages).values({
        id: imageId,
        tenantId,
        sampleId,
        objectKey,
        variant: "primary",
        isPrimary: index === 0,
        mimeType: "image/jpeg",
        byteSize: jpeg.length,
        width: size,
        height: size,
        sortOrder: index,
      });
      imageIds.push(imageId);
    }

    const thumbs = new SampleThumbService(db, tenantId, storage);
    const started = Date.now();
    for (const imageId of imageIds) await thumbs.derive(imageId);
    console.log(`派生完成：${count} 张 × 2 档，耗时 ${Date.now() - started}ms`);

    const rows = await db.select().from(sampleImages).where(eq(sampleImages.sampleId, sampleId));
    if (rows.length !== count) throw new Error(`DB 行数不符：${rows.length}/${count}`);

    // 改前：图墙拿到的就是原图 URL（历史行为：thumbUrl 回退原图 / CDN 参数在 MinIO 不生效）。
    let originalBytes = 0;
    for (const row of rows) {
      const response = await fetch(await media.imageUrl(row.objectKey));
      if (!response.ok) throw new Error(`原图取不到：${row.objectKey} → HTTP ${response.status}`);
      originalBytes += (await response.arrayBuffer()).byteLength;
    }

    // 改后：首屏只允许请求 _320.webp。
    let thumbBytes = 0;
    let notThumb = 0;
    for (const row of rows) {
      const presented = await media.present(row);
      if (!presented.thumbUrl) throw new Error(`图片 ${row.id} 没有 thumbUrl`);
      const expected = thumbObjectKey(tenantId, sampleId, row.id, 320);
      if (!presented.thumbUrl.includes(expected)) {
        notThumb += 1;
        throw new Error(`首屏拿到了非 320 缩略图：${presented.thumbUrl}`);
      }
      if (presented.thumbStatus !== "ready") {
        throw new Error(`缩略图状态不是 ready：${presented.thumbStatus}`);
      }
      const response = await fetch(presented.thumbUrl);
      if (!response.ok) throw new Error(`缩略图取不到：${presented.thumbUrl}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/webp")) {
        throw new Error(`缩略图 content-type 不是 webp：${contentType}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const meta = await sharp(bytes).metadata();
      if ((meta.width ?? 0) > 320) throw new Error(`缩略图宽度 ${meta.width} > 320`);
      thumbBytes += bytes.length;
    }

    // 详情抽屉：640 档单独量一次。
    let detailBytes = 0;
    for (const row of rows) {
      const presented = await media.present(row);
      if (!presented.detailUrl) throw new Error(`图片 ${row.id} 没有 detailUrl`);
      const response = await fetch(presented.detailUrl);
      if (!response.ok) throw new Error(`详情图取不到：${presented.detailUrl}`);
      detailBytes += (await response.arrayBuffer()).byteLength;
    }

    const savedPct = originalBytes > 0 ? (1 - thumbBytes / originalBytes) * 100 : 0;
    console.log("\n图墙首屏（50 张卡片同口径）");
    console.log(`  改前：${mb(originalBytes)}（平均 ${kb(originalBytes / count)}/张）`);
    console.log(`  改后：${mb(thumbBytes)}（平均 ${kb(thumbBytes / count)}/张）`);
    console.log(`  降幅：${savedPct.toFixed(1)}%，节省 ${mb(originalBytes - thumbBytes)}`);
    console.log(`  首屏请求命中 _320.webp：${count - notThumb}/${count}`);
    console.log(`  详情抽屉 _640.webp 合计：${mb(detailBytes)}`);
    console.log("\n✔ 验收通过：本地 MinIO 下图墙只拉派生缩略图。");

    if (keep) {
      console.log(`\n--keep：保留租户 ${tenantId}（样品 ${sampleId}）供人工查看。`);
      return;
    }
  } finally {
    if (!keep && tenantId) {
      // 先清桶（含缩略图），再删库；顺序反过来会丢掉 objectKey 线索。
      const prefix = `tenant/${tenantId}/samples/`;
      if (storage.list) {
        for (const object of await storage.list(prefix)) {
          await storage.delete(object.key).catch(() => undefined);
        }
      }
      await db.delete(sampleImages).where(eq(sampleImages.tenantId, tenantId));
      if (sampleId) await db.delete(samples).where(eq(samples.id, sampleId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
    await pool.end();
    await probe.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 缩略图验收失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
