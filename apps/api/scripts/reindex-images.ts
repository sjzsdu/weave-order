/**
 * 样品图像向量索引重算（S4）。
 *
 * 用法：
 *   pnpm --filter @weave-order/api reindex:images                    # 全部租户，只补缺失向量
 *   pnpm --filter @weave-order/api reindex:images -- --tenant=<uuid>
 *   pnpm --filter @weave-order/api reindex:images -- --ensure-index   # 顺手建当前模型的 HNSW 索引
 *
 * 什么时候需要跑：
 * - 从 S3 升级到 S4 后（历史图片 `index_status = pending`，还没有向量）；
 * - 换了 `IMAGE_EMBEDDING_MODEL` / `IMAGE_EMBEDDING_DIMENSION`（新模型没有向量）。
 *
 * 换模型的标准流程（不需要改表结构、不需要停服）：
 *   1. 改 env 里的 IMAGE_EMBEDDING_MODEL / DIMENSION；
 *   2. `reindex:images --ensure-index`（新建该模型的 partial HNSW 索引并回填）；
 *   3. 重启 API。旧模型的向量行留着，随时可以回滚。
 *
 * 失败行会写进 `sample_images.index_status = failed` + `index_error`，退出码 1。
 */
import path from "node:path";
import { Pool } from "pg";
import { createDb } from "@weave-order/db";
import { createImageEmbeddingProviderFromEnv } from "../src/platform/embedding";
import { loadEnv } from "../src/platform/env";
import { createObjectStorageFromEnv } from "../src/platform/storage";
import { ImageIndexService } from "../src/kernel/image-index.service";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值（local-stub + 本地 MinIO）
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const embedder = createImageEmbeddingProviderFromEnv(env, process.env.DASHSCOPE_API_KEY);
  const storage = createObjectStorageFromEnv(env);
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
  const probe = new Pool({ connectionString: databaseUrl, max: 1 });
  const { db, pool } = createDb(databaseUrl);
  const ensureIndex = process.argv.slice(2).includes("--ensure-index");

  try {
    const tenantId = argValue("tenant");
    let tenantIds: string[];
    if (tenantId) {
      tenantIds = [tenantId];
    } else {
      const rows = await probe.query<{ id: string }>("SELECT id FROM tenants ORDER BY created_at");
      tenantIds = rows.rows.map((row) => row.id);
    }

    console.log(
      `图像索引重算：provider=${embedder.name}（semantic=${String(embedder.semantic)}，` +
        `dim=${embedder.dimension}），租户 ${tenantIds.length} 个`,
    );
    if (!embedder.semantic) {
      console.warn(
        "⚠ 当前是 local-stub：算出来的是哈希向量，只能验证链路，不携带视觉语义。" +
          "生产请设 IMAGE_EMBEDDING_PROVIDER=dashscope-qwen3-vl。",
      );
    }

    let failed = 0;
    for (const id of tenantIds) {
      const index = new ImageIndexService(db, embedder, id, storage);
      if (ensureIndex) {
        const name = await index.ensureHnswIndex();
        console.log(`- 租户 ${id}：HNSW 索引就绪（${name}）`);
      }
      const result = await index.reindexTenant();
      failed += result.failures.length;
      console.log(
        `- 租户 ${id}：图片总数 ${result.total}，写入 ${result.indexed}，` +
          `跳过 ${result.skipped}，失败 ${result.failures.length}`,
      );
      for (const failure of result.failures.slice(0, 5)) {
        console.log(`  ! 图片 ${failure.imageId}（样品 ${failure.sampleId}）：${failure.message.slice(0, 200)}`);
      }
    }
    if (failed > 0) {
      console.error(`✖ 有 ${failed} 张图片索引失败；修好模型/对象存储后重跑本命令（只会补缺失行）。`);
      process.exitCode = 1;
    } else {
      console.log("✔ 图像索引完成");
    }
  } finally {
    await pool.end();
    await probe.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 图像索引失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
