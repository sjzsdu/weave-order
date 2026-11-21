/**
 * 存量克重回填（WAN-188）。
 *
 * 用法：
 *   pnpm --filter @weave-order/api backfill:weight-gsm               # 只读巡检：生成清单，不改库
 *   pnpm --filter @weave-order/api backfill:weight-gsm -- --apply   # 按解析结果写入 weight_gsm
 *   ... -- --tenant=<uuid> --out=./report.json
 *
 * 口径与写入侧完全相同：只认 `parseWeightGsm` 的「单一数值 + 明确单位」。
 * 解析失败**不猜**，只把 `code + 原文` 列进清单交人工补；已有 weight_gsm
 * 不会被清空（新增列首跑时都是 null，之后人工修正过的值不能被脚本覆盖）。
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { parseWeightGsm } from "@weave-order/schema";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值
}

export interface WeightBackfillFailure {
  sampleId: string;
  code: string;
  weight: string;
}

export interface WeightBackfillReport {
  applied: boolean;
  tenantId: string | null;
  total: number;
  parsed: number;
  /** 本次会写入 / 已写入的行数（只处理 weight_gsm 为空的列）。 */
  updated: number;
  /** 已有人工值而被保留、未参与写入的行数。 */
  preserved: number;
  failed: number;
  failures: WeightBackfillFailure[];
}

interface SampleRow {
  id: string;
  tenant_id: string;
  code: string;
  weight: string;
  weight_gsm: number | null;
}

export async function backfillWeightGsm(
  pool: Pool,
  options: { apply: boolean; tenantId?: string | null },
): Promise<WeightBackfillReport> {
  const rows = await pool.query<SampleRow>(
    `SELECT id, tenant_id, code, weight, weight_gsm
       FROM samples
      WHERE weight IS NOT NULL
        AND btrim(weight) <> ''
        ${options.tenantId ? "AND tenant_id = $1" : ""}
      ORDER BY tenant_id, created_at, id`,
    options.tenantId ? [options.tenantId] : [],
  );

  const report: WeightBackfillReport = {
    applied: options.apply,
    tenantId: options.tenantId ?? null,
    total: rows.rowCount ?? rows.rows.length,
    parsed: 0,
    updated: 0,
    preserved: 0,
    failed: 0,
    failures: [],
  };

  for (const row of rows.rows) {
    const gsm = parseWeightGsm(row.weight);
    if (gsm === null) {
      report.failed += 1;
      report.failures.push({ sampleId: row.id, code: row.code, weight: row.weight });
      continue;
    }
    report.parsed += 1;
    // 已有值（可能是人工修正）一律保留：回填只填补空白，绝不覆盖。
    if (row.weight_gsm !== null) {
      report.preserved += 1;
      continue;
    }
    if (options.apply) {
      await pool.query(`UPDATE samples SET weight_gsm = $2 WHERE id = $1 AND weight_gsm IS NULL`, [
        row.id,
        gsm,
      ]);
    }
    report.updated += 1;
  }
  return report;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenant = process.argv.find((arg) => arg.startsWith("--tenant="))?.slice("--tenant=".length);
  const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order",
    max: 2,
  });
  try {
    const report = await backfillWeightGsm(pool, { apply, tenantId: tenant ?? null });
    const outputPath = path.resolve(out ?? "backfill-weight-gsm-report.json");
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      `${apply ? "已写入" : "只读巡检"}：共 ${report.total} 条，解析成功 ${report.parsed} 条，` +
        `${apply ? "更新" : "待更新"} ${report.updated} 条，` +
        `保留已有值 ${report.preserved} 条，失败 ${report.failed} 条。`,
    );
    console.log(`失败清单：${outputPath}`);
    if (report.failed > 0) {
      for (const failure of report.failures.slice(0, 20)) {
        console.log(`  - ${failure.code}: ${JSON.stringify(failure.weight)}`);
      }
      if (report.failed > 20) console.log(`  …另有 ${report.failed - 20} 条见清单`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main();
}
