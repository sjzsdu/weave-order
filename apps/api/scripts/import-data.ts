/**
 * 第六步冷启动导入：把样例客户 / 样品数据导入确定性内核。
 *
 * 运行：pnpm import（根脚本先跑 migrate，再跑本脚本）
 * 默认读 data/seed/customers.csv + samples.csv；也可用环境变量切换：
 *   IMPORT_XLSX=<path>        单工作簿（含 customers / samples 两个 sheet）
 *   IMPORT_CUSTOMERS=<path>   自定义客户 CSV
 *   IMPORT_SAMPLES=<path>     自定义样品 CSV
 *
 * 本脚本是「人类发起的运维动作」：固定 HUMAN 上下文，所有落库都经内核
 * ImportService，逐行用 packages/schema 契约严格校验、整批原子、同事务审计。
 *
 * 默认口径不变：库中已有同 code 行 => 整批拒绝（DUPLICATE_IN_DB），不会重复落库。
 * 需要重导同一份 seed 时显式开启重置：
 *   SEED_RESET=1 pnpm seed
 * 同一事务内先删除同 code 的旧客户/样品及其报价、寄样引用，再整批写入；
 * 任何一步失败都整批回滚，旧数据不会丢一半。
 */
import path from "node:path";
import { buildBatch, readRecords } from "../src/import";
import { createKernel } from "../src/kernel";
import { connectDatabase } from "../src/platform/database";
import { loadEnv } from "../src/platform/env";
import { demoWriteContext, ensureDemoIdentity } from "../src/kernel/demo-identity";

// 可选：仓库根目录存在 .env 时加载（Node 20.12+）。
try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值。
}

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_CUSTOMERS = path.join(REPO_ROOT, "data/seed/customers.csv");
const DEFAULT_SAMPLES = path.join(REPO_ROOT, "data/seed/samples.csv");

function resolveInput(value: string): string {
  return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = connectDatabase(env.DATABASE_URL);
  try {
    const tableCheck = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.customers') IS NOT NULL AS exists",
    );
    if (!tableCheck.rows[0]?.exists) {
      throw new Error("数据库表不存在，请先运行：pnpm db:migrate");
    }

    const xlsx = process.env.IMPORT_XLSX;
    const customersPath = resolveInput(process.env.IMPORT_CUSTOMERS ?? DEFAULT_CUSTOMERS);
    const samplesPath = resolveInput(process.env.IMPORT_SAMPLES ?? DEFAULT_SAMPLES);

    const customerRecords = xlsx
      ? await readRecords(resolveInput(xlsx), "customers")
      : await readRecords(customersPath);
    const sampleRecords = xlsx
      ? await readRecords(resolveInput(xlsx), "samples")
      : await readRecords(samplesPath);
    const batch = buildBatch(customerRecords, sampleRecords);

    console.log(`导入来源：${xlsx ?? `${customersPath} + ${samplesPath}`}`);
    console.log(`待导入：客户 ${batch.customers.length} 行 / 样品 ${batch.samples.length} 行`);

    const resetExisting = process.env.SEED_RESET === "1" || process.env.SEED_RESET === "true";
    if (resetExisting) {
      console.log("重置模式：库中同 code 的旧客户/样品（含其报价、寄样引用）将先删除再导入");
    }

    // 演示/seed 数据必须有归属人：否则 dataScope=OWN 的成员（SALES）全都看不到，
    // 冷启动后客户与报价列表会是空的（WAN-106）。
    const identity = await ensureDemoIdentity(db);
    console.log(
      `归属：客户挂到演示业务员成员 ${identity.salesMembershipId}（OWNER ${identity.ownerMembershipId} 用 ALL 看全量）`,
    );
    const kernel = createKernel(db, undefined, { tenantId: identity.tenantId });
    const result = await kernel.importing.execute(
      batch,
      demoWriteContext(identity, "import-operator"),
      {
        resetExisting,
      },
    );

    console.log(
      `\n结果：committed=${result.committed} · 客户 ${result.importedCustomers} · 样品 ${result.importedSamples} · 回执 ${result.rows.length} 行`,
    );
    if (result.batchError) {
      console.log(`批次错误：${result.batchError.code} — ${result.batchError.message}`);
    }
    for (const row of result.rows) {
      if (!row.ok) {
        console.log(
          `  ✖ [${row.kind}#${row.row}] ${row.key}: ${row.error.code} ${row.error.message}`,
        );
      }
    }
    if (result.committed) {
      console.log(`审计 correlationId=${result.correlationId ?? "-"}（全部 HUMAN 上下文、同事务）`);
      console.log("✔ 冷启动数据已就位：pnpm dev 后可直接派发意图 / 审批 / 看全景");
    } else {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("\n✖ 导入失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
