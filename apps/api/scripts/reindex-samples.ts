/**
 * 样品文本向量索引重算（S3）。
 *
 * 用法：
 *   pnpm --filter @weave-order/api reindex:samples                  # 全部租户，按 contentHash 跳过未变行
 *   pnpm --filter @weave-order/api reindex:samples -- --tenant=<uuid>
 *
 * - 只重算 `contentHash` 变化或缺失的样品：改名 / 改成分 / 改克重才调用模型。
 * - 有失败行时退出码 1（后台任务据此告警）；已成功的行不会回滚。
 * - 需要真实语义模型时先配 `EMBEDDING_PROVIDER=dashscope-text-v3` + key。
 */
import path from "node:path";
import { Pool } from "pg";
import { createDb } from "@weave-order/db";
import { createEmbeddingProviderFromEnv } from "../src/platform/embedding";
import { loadEnv } from "../src/platform/env";
import { SampleIndexService } from "../src/kernel/sample-index.service";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const embedder = createEmbeddingProviderFromEnv(env, process.env.DASHSCOPE_API_KEY);
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
  const probe = new Pool({ connectionString: databaseUrl, max: 1 });
  const { db, pool } = createDb(databaseUrl);

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
      `索引重算：provider=${embedder.name}（semantic=${String(embedder.semantic)}），` +
        `租户 ${tenantIds.length} 个`,
    );
    let failed = 0;
    for (const id of tenantIds) {
      const index = new SampleIndexService(db, embedder, id);
      const result = await index.reindexTenant();
      failed += result.failures.length;
      console.log(
        `- 租户 ${id}：总数 ${result.total}，写入 ${result.indexed}，跳过 ${result.skipped}，` +
          `失败 ${result.failures.length}`,
      );
      for (const failure of result.failures.slice(0, 5)) {
        console.log(`  ! ${failure.code}（${failure.sampleId}）：${failure.message.slice(0, 200)}`);
      }
    }
    if (failed > 0) {
      console.error(`✖ 有 ${failed} 条样品索引失败；修复模型/网络后重跑本命令。`);
      process.exitCode = 1;
    } else {
      console.log("✔ 索引重算完成");
    }
  } finally {
    await pool.end();
    await probe.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 索引重算失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
