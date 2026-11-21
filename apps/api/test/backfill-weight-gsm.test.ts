import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { backfillWeightGsm } from "../scripts/backfill-weight-gsm";

/**
 * 回填脚本的行为边界（WAN-188 返工）：
 * - 只读：绝不发 UPDATE；
 * - 写入：只填 `weight_gsm IS NULL` 的行；
 * - 保留：已有人工值（哪怕与解析值不一致）不覆盖，并单独计数。
 * 用假 Pool 断言 SQL 与参数，不依赖真实数据库。
 */

interface FakeRow {
  id: string;
  tenant_id: string;
  code: string;
  weight: string;
  weight_gsm: number | null;
}

interface RecordedQuery {
  sql: string;
  params: unknown[] | undefined;
}

function fakePool(rows: FakeRow[]): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("FROM samples")) {
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  } as unknown as Pool;
  return { pool, queries };
}

const rows: FakeRow[] = [
  // 空白列：应被回填。
  {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "t",
    code: "S-EMPTY",
    weight: "220g/m2",
    weight_gsm: null,
  },
  // 人工值 999 与解析值 220 不同：保留，不得覆盖。
  {
    id: "22222222-2222-4222-8222-222222222222",
    tenant_id: "t",
    code: "S-MANUAL",
    weight: "220g/m2",
    weight_gsm: 999,
  },
  // 已有值恰好相同：也不重写。
  {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: "t",
    code: "S-SAME",
    weight: "220g/m2",
    weight_gsm: 220,
  },
  // 解析失败：进失败清单，不写库。
  {
    id: "44444444-4444-4444-8444-444444444444",
    tenant_id: "t",
    code: "S-BAD",
    weight: "32S/2",
    weight_gsm: null,
  },
];

describe("backfillWeightGsm", () => {
  it("只读巡检：不发 UPDATE，空白列计入待更新，已有值计入保留", async () => {
    const { pool, queries } = fakePool(rows);
    const report = await backfillWeightGsm(pool, { apply: false });

    expect(queries.filter((query) => query.sql.startsWith("UPDATE"))).toHaveLength(0);
    expect(report.total).toBe(4);
    expect(report.parsed).toBe(3);
    expect(report.updated).toBe(1);
    expect(report.preserved).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.failures).toEqual([{ sampleId: rows[3]?.id, code: "S-BAD", weight: "32S/2" }]);
  });

  it("--apply 只写空白列，UPDATE 带 weight_gsm IS NULL 守卫", async () => {
    const { pool, queries } = fakePool(rows);
    const report = await backfillWeightGsm(pool, { apply: true });

    const updates = queries.filter((query) => query.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain("weight_gsm IS NULL");
    expect(updates[0]?.params).toEqual([rows[0]?.id, 220]);
    expect(report.updated).toBe(1);
  });

  it("--apply 保留人工修正值：与解析值不一致的非空行不被改写", async () => {
    const { pool, queries } = fakePool([rows[1]!]);
    const report = await backfillWeightGsm(pool, { apply: true });

    expect(queries.filter((query) => query.sql.startsWith("UPDATE"))).toHaveLength(0);
    expect(report.preserved).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.failed).toBe(0);
  });
});
