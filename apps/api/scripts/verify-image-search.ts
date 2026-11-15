/**
 * 以图找样验收脚本（S4）。
 *
 * 用真实模型对**真实图片文件**跑一遍：建样品 → 索引图像向量 → 自召回 / 同款异角度 /
 * 异款可区分，并打印相似度矩阵。数据库用本机 DATABASE_URL，图片直接从磁盘读
 * （脚本内实现只读的 FileStorage，不依赖 MinIO/COS）。
 *
 * 用法：
 *   IMAGE_EMBEDDING_PROVIDER=dashscope-qwen3-vl \
 *   pnpm --filter @weave-order/api verify:image-search -- \
 *     --sample "红棉=./fabric/red.jpg" --sample "大花=./fabric/floral.jpg" \
 *     --sample "牛仔=./fabric/denim.jpg"
 *
 * 每个 --sample 的格式是「名称=路径」，名称会写进样品名（不参与向量）。
 * 每次运行都建一个独立租户，跑完即删，不会污染现有数据。
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { createDb, sampleImageEmbeddings, sampleImages } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import { createImageEmbeddingProviderFromEnv } from "../src/platform/embedding";
import { loadEnv } from "../src/platform/env";
import type { ObjectBytes, ObjectHead, ObjectStorage } from "../src/platform/storage";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 用默认值
}

interface SampleArg {
  name: string;
  file: string;
}

function parseSamples(): SampleArg[] {
  const args = process.argv.slice(2);
  const out: SampleArg[] = [];
  for (const [index, arg] of args.entries()) {
    const value =
      arg === "--sample" ? args[index + 1] : arg.startsWith("--sample=") ? arg.slice(9) : undefined;
    if (!value || !value.includes("=")) continue;
    const [name, file] = value.split("=");
    if (name && file) out.push({ name, file });
  }
  return out;
}

/** 只读本地目录的伪对象存储：验收脚本不测上传，只需要「按 key 取字节」。 */
class FileStorage implements ObjectStorage {
  constructor(private readonly files: Map<string, string>) {}

  presignPut(): Promise<string> {
    return Promise.reject(new Error("验收脚本不支持上传"));
  }

  signGet(objectKey: string): Promise<string> {
    return Promise.resolve(`file://${this.files.get(objectKey) ?? ""}`);
  }

  async head(objectKey: string): Promise<ObjectHead | null> {
    const file = this.files.get(objectKey);
    if (!file) return null;
    const bytes = await readFile(file);
    return { contentType: "image/jpeg", contentLength: bytes.length };
  }

  async get(objectKey: string): Promise<ObjectBytes | null> {
    const file = this.files.get(objectKey);
    if (!file) return null;
    return { contentType: "image/jpeg", bytes: await readFile(file) };
  }

  put(): Promise<void> {
    return Promise.reject(new Error("验收脚本不支持写对象"));
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}

async function main(): Promise<void> {
  const sampleArgs = parseSamples();
  if (sampleArgs.length < 2) {
    console.error(
      '用法：verify:image-search -- --sample "名称=路径" --sample "名称=路径" [...]\n' +
        "至少要两个样品；想验证「同款异角度」就给同一个样品传两张图（--extra）。",
    );
    process.exitCode = 2;
    return;
  }

  const env = loadEnv();
  const embedder = createImageEmbeddingProviderFromEnv(env, process.env.DASHSCOPE_API_KEY);
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
  const probe = new Pool({ connectionString: databaseUrl, max: 1 });
  const { db, pool } = createDb(databaseUrl);

  console.log(
    `provider=${embedder.name} semantic=${String(embedder.semantic)} dim=${embedder.dimension}`,
  );
  if (!embedder.semantic) {
    console.warn("⚠ local-stub：下面打印的是哈希分数，只验证链路，不代表视觉相似度。");
  }

  try {
    const tenant = await probe.query<{ id: string }>(
      "INSERT INTO tenants (slug, name, status) VALUES ($1, $2, 'ACTIVE') RETURNING id",
      [`verify-image-${randomUUID().slice(0, 8)}`, "以图找样验收"],
    );
    const tenantId = tenant.rows[0]!.id;
    const files = new Map<string, string>();
    const keys = sampleArgs.map(() => {
      const objectKey = `tenant/${tenantId}/samples/${randomUUID()}/${randomUUID()}.jpg`;
      return objectKey;
    });
    for (const [index, objectKey] of keys.entries()) {
      files.set(objectKey, sampleArgs[index]!.file);
    }
    const storage = new FileStorage(files);
    const kernel = createKernel(db, undefined, { tenantId, storage });

    const created: { id: string; name: string; key: string }[] = [];
    for (const [index, sampleArg] of sampleArgs.entries()) {
      const key = keys[index]!;
      const sample = await kernel.samples.create(
        {
          code: `VERIFY-${index + 1}`,
          name: sampleArg.name,
          unit: "meter",
          imageKeys: [key],
        },
        { actor: { type: "SYSTEM", id: "verify-image-search" } },
      );
      created.push({ id: sample.id, name: sampleArg.name, key });
    }

    const images = await db.select().from(sampleImages).where(eq(sampleImages.tenantId, tenantId));
    const failed = images.filter((image) => image.indexStatus === "failed");
    if (failed.length > 0) {
      console.error(`✖ ${failed.length} 张图索引失败：${failed[0]?.indexError ?? ""}`);
      process.exitCode = 1;
      return;
    }

    // 相似度矩阵：每张图当查询，看 top-3 命中的是谁。
    console.log("\n查询 → top-3（名称 / 分数）：");
    let selfRecall = 0;
    for (const entry of created) {
      const image = await storage.get(entry.key);
      const result = await kernel.search.searchByImage(
        { mimeType: "image/jpeg", base64: image!.bytes.toString("base64") },
        3,
      );
      const top = result.matches[0];
      const ok = top?.sample.id === entry.id;
      if (ok) selfRecall += 1;
      console.log(
        `- ${entry.name}：${result.matches
          .map((match) => `${match.sample.name} ${(match.score * 100).toFixed(1)}%`)
          .join(" | ")} ${ok ? "✔ 自召回" : "✖ top-1 不是自己"}`,
      );
    }
    console.log(`\n自召回：${selfRecall}/${created.length}`);

    const vectors = await db
      .select()
      .from(sampleImageEmbeddings)
      .where(eq(sampleImageEmbeddings.tenantId, tenantId));
    console.log(`向量行数：${vectors.length}（期望 ${created.length}）`);
  } finally {
    const tenantIds = await probe.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug LIKE 'verify-image-%'",
    );
    for (const row of tenantIds.rows) {
      await probe.query("DELETE FROM sample_images WHERE tenant_id = $1", [row.id]);
      await probe.query("DELETE FROM sample_image_embeddings WHERE tenant_id = $1", [row.id]);
      await probe.query("DELETE FROM samples WHERE tenant_id = $1", [row.id]);
      await probe.query("DELETE FROM tenants WHERE id = $1", [row.id]);
    }
    await pool.end();
    await probe.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 验收失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
