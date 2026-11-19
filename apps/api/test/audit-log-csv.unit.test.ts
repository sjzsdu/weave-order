import { describe, expect, it } from "vitest";
import { countCsvRows } from "../src/kernel/audit-log.service";

/**
 * 导出行数用于任务详情与审计快照，必须与写入的行数一致：
 * `entity_label` 带换行时会被 CSV 引号包住，不能按 `split("\n")` 虚增。
 */
describe("countCsvRows", () => {
  it("按记录数计数，引号内的换行不拆行", () => {
    const csv = '\uFEFF时间,对象\r\n2026-01-01,客户 A\r\n2026-01-02,"客户\nB"\r\n';
    expect(countCsvRows(csv)).toBe(2);
  });

  it("只有表头 → 0 行", () => {
    expect(countCsvRows("时间,对象\r\n")).toBe(0);
  });

  it("没有结尾换行时最后一行仍计数", () => {
    expect(countCsvRows("h\r\n1\r\n2")).toBe(2);
  });

  it("空字段与转义引号不误判", () => {
    const csv = 'h1,h2\r\n"a ""quoted"" cell",\r\n';
    expect(countCsvRows(csv)).toBe(1);
  });
});
