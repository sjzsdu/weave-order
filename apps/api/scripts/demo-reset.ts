/**
 * `pnpm demo:reset`：把当前库恢复到「刚 seed 完」的演示状态。
 *
 * 步骤（顺序不能换）：
 *   1. 入口门控：生产环境拒绝执行（本地 dev 与 WEAVE_ENV=test 才放行）
 *   2. 清对象存储 `tenant/<id>/`（复用 maintain:media 的租户前缀清理逻辑）
 *   3. DROP SCHEMA public；DROP SCHEMA drizzle（迁移记录，否则 migrate 会以为已应用）
 *   4. migrate（含 RLS）→ seed（CSV）→ demo:scenes（剧本锚点）
 *   5. 清 Redis 会话 `weave:session:*`
 *
 * 第 5 步是「重置完白屏」的根因修复：浏览器旧 sid 还指向已不存在的 membership，
 * `resolveMembership` 抛 PERMISSION_DENIED，页面只剩空白。数据重置必须连会话一起刷。
 *
 * 幂等：每次都从空白 schema 开始，连跑两次得到同一组表 / 同一批种子数据
 * （uuid 会变，所以剧本按业务锚点而不是 id 解析）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import Redis from "ioredis";
import {
  canResetDemoData,
  isProductionLike,
  isTestEnv,
  needsDemoResetConfirmation,
} from "@weave-order/schema";
import { createDb } from "@weave-order/db";
import { loadEnv } from "../src/platform/env";
import { createObjectStorageFromEnv } from "../src/platform/storage";
import { MediaMaintenanceService } from "../src/kernel/media-maintenance.service";
import { SampleThumbService } from "../src/kernel/sample-thumbs.service";

function findRepoRoot(start = __dirname): string {
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`找不到仓库根（从 ${start} 向上查找 pnpm-workspace.yaml）`);
}

const REPO_ROOT = findRepoRoot();
try {
  process.loadEnvFile(path.join(REPO_ROOT, ".env"));
} catch {
  // 没有 .env 就用默认值（本地 docker-compose 口径）。
}

/** 入口门控：与 api 启动门控共用 `canResetDemoData`，不允许脚本自己再写一份判断。 */
function assertAllowed(): void {
  const env = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_MODE: process.env.AUTH_MODE,
    WEAVE_ENV: process.env.WEAVE_ENV,
  };
  if (!canResetDemoData(env)) {
    const detail = isTestEnv(env)
      ? "WEAVE_ENV=test 已设置，但生产态判定仍为 true（这不应发生）"
      : "当前是生产环境（NODE_ENV=production 或 AUTH_MODE=oidc），且未设置 WEAVE_ENV=test";
    console.error("✖ 拒绝执行 demo:reset：" + detail + "。");
    console.error(
      "  生产库不允许被一键清空。测试环境请显式设置 WEAVE_ENV=test；本地请用 NODE_ENV=development + AUTH_MODE=dev。",
    );
    process.exitCode = 1;
    throw new Error("DEMO_RESET_FORBIDDEN");
  }

  // 第二道门：测试环境与生产只差 WEAVE_ENV=test 一个变量，误拷 .env.test 就能清库。
  // 生产态下必须再显式确认一次，并把目标库打在屏幕上，避免「我以为连的是测试库」。
  if (needsDemoResetConfirmation({ ...env, DEMO_RESET_CONFIRM: process.env.DEMO_RESET_CONFIRM })) {
    console.error("✖ 拒绝执行 demo:reset：当前是生产态（测试环境），需要显式确认。");
    console.error(`  目标库：${redactDatabaseUrl(process.env.DATABASE_URL)}`);
    console.error("  确认无误后重跑：DEMO_RESET_CONFIRM=1 pnpm demo:reset");
    process.exitCode = 1;
    throw new Error("DEMO_RESET_FORBIDDEN");
  }
}

/** 只保留 host:port/db，密码不进日志。 */
function redactDatabaseUrl(url: string | undefined): string {
  if (!url) return "（未设置 DATABASE_URL）";
  return url.replace(/:\/\/[^@]*@/, "://***@");
}

function run(command: string, args: string[], label: string): void {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${label} 失败（exit ${result.status ?? "signal"}）`);
  }
}

/** 迁移记录在 `drizzle` schema：只 DROP public 会让 migrate 误判「已应用」而跳过建表。 */
async function dropSchemas(databaseUrl: string): Promise<void> {
  const { pool } = createDb(databaseUrl);
  try {
    console.log("\n▶ 清空 schema");
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query("CREATE SCHEMA public");
    console.log("✔ public / drizzle 已重建");
  } finally {
    await pool.end();
  }
}

async function purgeObjects(): Promise<void> {
  console.log("\n▶ 清理对象存储 tenant/<id>/");
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const tenants = await pool
      .query<{ id: string }>("SELECT id FROM public.tenants")
      .catch(() => ({ rows: [] as { id: string }[] }));
    const ids = new Set(tenants.rows.map((row) => row.id));
    if (env.SEED_TENANT_ID) ids.add(env.SEED_TENANT_ID);
    if (ids.size === 0) {
      console.log("· 没有可清理的租户");
      return;
    }
    const storage = createObjectStorageFromEnv(env);
    for (const tenantId of ids) {
      try {
        const thumbs = new SampleThumbService(db, tenantId, storage);
        const maintenance = new MediaMaintenanceService(db, tenantId, storage, thumbs);
        const report = await maintenance.purgeTenantObjects();
        console.log(
          `   ${tenantId}: ${report.deleted}/${report.listed} 个对象` +
            (report.failures.length > 0 ? `，失败 ${report.failures.length}` : ""),
        );
      } catch (error) {
        // 本地 docker compose 的 MinIO 在 media profile 里，默认可能没起：
        // 数据重置不应该被对象存储挡住，但必须明确告诉操作者桶里还有残留。
        console.warn(
          `   ⚠ ${tenantId}: 对象存储不可用，跳过（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

/** 重置会话：否则旧 sid 指向已不存在的 membership，表现为重置后白屏。 */
async function flushSessions(redisUrl: string): Promise<void> {
  console.log("\n▶ 清理 Redis 会话 weave:session:*");
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 2000,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", "weave:session:*", "COUNT", 200);
      cursor = next;
      if (keys.length > 0) {
        await client.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");
    console.log(`✔ 已清理 ${deleted} 个会话`);
  } catch (error) {
    console.warn(
      `⚠ Redis 不可用，跳过会话清理（${error instanceof Error ? error.message : String(error)}）；` +
        "多实例部署必须能连 Redis，否则重置后旧会话仍可能指向不存在的成员。",
    );
  } finally {
    await client.quit().catch(() => client.disconnect());
  }
}

async function reportCounts(databaseUrl: string): Promise<void> {
  const { pool } = createDb(databaseUrl);
  try {
    const result = await pool.query<{
      customers: string;
      samples: string;
      pending_quotes: string;
      pending_shipments: string;
    }>(`
      SELECT
        (SELECT count(*) FROM customers) AS customers,
        (SELECT count(*) FROM samples) AS samples,
        (SELECT count(*) FROM quotes WHERE status = 'DRAFT') AS pending_quotes,
        (SELECT count(*) FROM sample_shipments WHERE status = 'DRAFT') AS pending_shipments
    `);
    const row = result.rows[0];
    console.log(
      `\n✔ 重置完成：客户 ${row?.customers ?? 0} · 样品 ${row?.samples ?? 0} · ` +
        `待批报价 ${row?.pending_quotes ?? 0} · 待确认寄样 ${row?.pending_shipments ?? 0}`,
    );
    console.log(
      `   环境：${isProductionLike() ? "production-like" : "local"}${isTestEnv() ? " + WEAVE_ENV=test" : ""}`,
    );
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  assertAllowed();
  const env = loadEnv();
  console.log(`目标数据库：${redactDatabaseUrl(env.DATABASE_URL)}`);

  await purgeObjects();
  await dropSchemas(env.DATABASE_URL);
  run("pnpm", ["--filter", "@weave-order/db", "migrate"], "migrate");
  run("pnpm", ["--filter", "@weave-order/api", "seed"], "seed");
  run("pnpm", ["--filter", "@weave-order/api", "demo:scenes"], "demo:scenes");
  await flushSessions(env.REDIS_URL);
  await reportCounts(env.DATABASE_URL);
}

void main().catch((error: unknown) => {
  if (error instanceof Error && error.message === "DEMO_RESET_FORBIDDEN") return;
  console.error("\n✖ demo:reset 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
