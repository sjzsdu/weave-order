import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_PLANE_TABLES, EXPECTED_TABLES } from "../src/platform/schema-readiness";

/**
 * `sql/rls.sql` 的两份名单必须一致：能写的表（GRANT）与被 RLS 收口的表（business_tables）。
 *
 * 为什么要有这条测试：两张名单是手写的，漏在 GRANT 里的表**建得出来但用不了**——
 * WAN-147 就是这样，`intents` 在 business_tables 里、不在 GRANT 里，
 * 于是生产上所有意图接口 500（permission denied for table intents），
 * 而同批迁移的 `onboarding_state` 一切正常，看起来像「迁移没跑」。
 * 这种错只有拿 weave_app 真跑一次 SQL 才会暴露，本地用 owner 连接永远测不出来。
 */
const RLS_SQL = readFileSync(
  path.join(__dirname, "..", "..", "..", "packages", "db", "sql", "rls.sql"),
  "utf8",
);

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const sql = withoutComments(RLS_SQL);

const grantList = (() => {
  const match = /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON([\s\S]*?)TO\s+weave_app/i.exec(
    sql,
  );
  if (!match?.[1]) throw new Error("rls.sql 里找不到业务表的 GRANT 语句");
  return match[1]
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
})();

const businessTables = (() => {
  const match = /business_tables\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/i.exec(sql);
  if (!match?.[1]) throw new Error("rls.sql 里找不到 business_tables 数组");
  return [...match[1].matchAll(/'([^']+)'/g)].flatMap((entry) => entry[1] ?? []);
})();

describe("rls.sql：授权名单与 RLS 名单", () => {
  it("每张受 RLS 约束的业务表都对 weave_app 授权", () => {
    const granted = new Set(grantList);
    expect(businessTables.filter((table) => !granted.has(table))).toEqual([]);
  });

  it("意图与开张进度两张新表都在名单里（WAN-147 回归）", () => {
    expect(grantList).toContain("intents");
    expect(grantList).toContain("onboarding_state");
  });

  it("两份名单没有重复项（重复说明合并冲突没清理干净）", () => {
    expect(new Set(grantList).size).toBe(grantList.length);
    expect(new Set(businessTables).size).toBe(businessTables.length);
  });

  it("没有授权的表必须正是「控制面表」（新增表要么授权，要么在这里声明）", () => {
    const granted = new Set(grantList);
    const ungranted = EXPECTED_TABLES.filter((table) => !granted.has(table));
    expect([...ungranted].sort()).toEqual([...CONTROL_PLANE_TABLES].sort());
  });
});
