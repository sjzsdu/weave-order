import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBatch, readRecords, toCustomerRow, toSampleRow } from "../src/import";

const SEED = path.resolve(__dirname, "../../../data/seed");
const CUSTOMERS_CSV = path.join(SEED, "customers.csv");
const SAMPLES_CSV = path.join(SEED, "samples.csv");
const XLSX = path.join(SEED, "weave-order-seed.xlsx");

/** 解析器离线单测：只读仓库里已提交的样例 CSV / XLSX，不连数据库、不留临时文件。 */
describe("导入文件解析（CSV / XLSX，离线）", () => {
  it("CSV 客户文件：表头映射、5 行、首行字段正确", async () => {
    const records = await readRecords(CUSTOMERS_CSV);
    expect(records).toHaveLength(5);
    expect(records[0]?.code).toBe("C-SEED-001");
    expect(records[0]?.name).toBe("杭州织造有限公司");
    expect(records[0]?.tier).toBe("VIP");
  });

  it("CSV 样品文件：6 行，金额/币种是扁平列", async () => {
    const records = await readRecords(SAMPLES_CSV);
    expect(records).toHaveLength(6);
    expect(records[0]?.code).toBe("S-SEED-001");
    expect(records[0]?.costFloorAmount).toBe("1200");
    expect(records[0]?.costFloorCurrency).toBe("CNY");
  });

  it("XLSX 工作簿：按 sheet 名分别读出客户 / 样品", async () => {
    const customers = await readRecords(XLSX, "customers");
    const samples = await readRecords(XLSX, "samples");
    expect(customers).toHaveLength(3);
    expect(customers[0]?.code).toBe("C-XLSX-001");
    expect(samples).toHaveLength(3);
    expect(samples[0]?.code).toBe("S-XLSX-001");
    expect(samples[0]?.costFloorAmount).toBe("1200");
  });

  it("XLSX 不指定 sheet 时读第一个工作表", async () => {
    const records = await readRecords(XLSX);
    expect(records[0]?.code).toBe("C-XLSX-001");
  });

  it("不支持的扩展名显式报错", async () => {
    await expect(readRecords(path.join(SEED, "customers.txt"))).rejects.toThrow(
      /不支持的导入文件格式/,
    );
  });

  it("XLSX 缺少指定 sheet 显式报错", async () => {
    await expect(readRecords(XLSX, "不存在的表")).rejects.toThrow(/缺少工作表/);
  });

  it("toCustomerRow：空单元格省略（让 Zod 默认值生效）、context 是 JSON", () => {
    const row = toCustomerRow({
      code: "C-1",
      name: "甲公司",
      tier: "",
      contactEmail: "a@example.com",
      context: '{"preferenceNotes":["偏好高支棉"]}',
      contactName: "",
      contactPhone: "",
    }) as Record<string, unknown>;
    expect(row["code"]).toBe("C-1");
    expect(row["tier"]).toBeUndefined(); // 交给契约默认 REGULAR
    expect(row["context"]).toEqual({ preferenceNotes: ["偏好高支棉"] });
    expect(row["contactName"]).toBeUndefined();
  });

  it("toCustomerRow：非法 JSON 的 context 原样留字符串，交契约判 INVALID_INPUT", () => {
    const row = toCustomerRow({ code: "C-2", name: "乙", context: "{坏 JSON" }) as Record<
      string,
      unknown
    >;
    expect(row["context"]).toBe("{坏 JSON");
  });

  it("toSampleRow：金额转 number、坏金额变 NaN（交 Zod 拒绝）", () => {
    const good = toSampleRow({
      code: "S-1",
      name: "棉",
      unit: "meter",
      costFloorAmount: "1200",
      costFloorCurrency: "CNY",
    }) as { costFloor?: { amount: number; currency: string } };
    expect(good.costFloor).toEqual({ amount: 1200, currency: "CNY" });

    const bad = toSampleRow({
      code: "S-2",
      name: "棉",
      costFloorAmount: "abc",
      costFloorCurrency: "CNY",
    }) as { costFloor?: { amount: number } };
    expect(Number.isNaN(bad.costFloor?.amount)).toBe(true);
  });

  it("中文表头别名：颜色 / 克重(g/m²) 能映射到契约字段", () => {
    const row = toSampleRow({
      样品编号: "S-CN-1",
      品名: "精梳棉汗布",
      成分: "100% 棉",
      品类: "针织",
      颜色: "藏青",
      "克重(g/m²)": "220",
      单位: "米",
      状态: "在售",
    }) as Record<string, unknown>;
    expect(row["code"]).toBe("S-CN-1");
    expect(row["name"]).toBe("精梳棉汗布");
    expect(row["color"]).toBe("藏青");
    // 表头写明了单位，纯数字单元格补成完整克重原文。
    expect(row["weight"]).toBe("220g/m2");
    expect(row["unit"]).toBe("米");
  });

  it("克重列没写单位时不补单位：纯数字原样交给解析器判为不可解析", () => {
    const row = toSampleRow({ 编号: "S-CN-2", 品名: "棉", 克重: "220" }) as Record<string, unknown>;
    expect(row["weight"]).toBe("220");
  });

  it("区间与纱支原文原样进契约，不被改写成克重", () => {
    const range = toSampleRow({ code: "S-R", name: "棉", "克重(g/m²)": "220-240" }) as Record<
      string,
      unknown
    >;
    expect(range["weight"]).toBe("220-240");
    const yarn = toSampleRow({ code: "S-Y", name: "棉", weight: "32S/2" }) as Record<
      string,
      unknown
    >;
    expect(yarn["weight"]).toBe("32S/2");
  });

  it("buildBatch 组装出 ImportBatch 信封（行仍是 unknown，由内核校验）", () => {
    const batch = buildBatch(
      [{ code: "C-1", name: "甲" }],
      [{ code: "S-1", name: "棉", costFloorAmount: "900", costFloorCurrency: "CNY" }],
    );
    expect(batch.customers).toHaveLength(1);
    expect(batch.samples).toHaveLength(1);
    expect(batch.customers[0]).toEqual({ code: "C-1", name: "甲" });
  });
});
