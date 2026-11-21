import { describe, expect, it } from "vitest";
import { MAX_IMPORT_ROWS } from "@weave-order/schema";
import { parseCsvRecords } from "./csv";
import { SAMPLE_CSV_TEMPLATE, parseSampleCsv, sampleImportRowErrorText } from "./sample-import";

describe("parseSampleCsv", () => {
  it("模板能被自己的解析器读回来，单位与成本底线按契约定型", () => {
    const parsed = parseSampleCsv(SAMPLE_CSV_TEMPLATE);
    expect(parsed.error).toBeNull();
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.values).toMatchObject({
      code: "SP-0001",
      name: "32S 精梳棉汗布",
      composition: "100% 棉",
      category: "针织",
      color: "本白",
      weight: "220g/m²",
      unit: "meter",
      status: "ACTIVE",
      costFloor: { amount: 1850, currency: "CNY" },
    });
  });

  it("中文表头、中文单位与状态也认", () => {
    const parsed = parseSampleCsv(
      "样品编号,品名,单位,状态,成本底线\nS9,涤纶四面弹,公斤,已归档,9.9\n",
    );
    expect(parsed.error).toBeNull();
    expect(parsed.rows[0]?.values).toMatchObject({
      code: "S9",
      name: "涤纶四面弹",
      unit: "kilogram",
      status: "ARCHIVED",
      costFloor: { amount: 990, currency: "CNY" },
    });
  });

  it("颜色列与「克重(g/m²)」中文表头都认", () => {
    const parsed = parseSampleCsv("样品编号,品名,颜色,克重(g/m²)\nS10,亚麻平纹,本白,220\n");
    expect(parsed.error).toBeNull();
    expect(parsed.rows[0]?.values).toMatchObject({
      code: "S10",
      name: "亚麻平纹",
      color: "本白",
      weight: "220g/m2",
    });
  });

  it("成本底线不是数字时原样交给服务端判 INVALID_INPUT，不在本地猜", () => {
    const parsed = parseSampleCsv("code,name,costFloorYuan\nS1,汗布,abc\n");
    expect(parsed.rows[0]?.values.costFloor).toBe("abc");
  });

  it("表头缺必填列 / 有陌生列时直接拒绝", () => {
    expect(parseSampleCsv("code,unit\nS1,meter\n").error).toContain("name");
    expect(parseSampleCsv("code,name,colourx\nS1,汗布,红\n").error).toContain("colourx");
  });

  it("空行被跳过并计数；超上限给出拆分提示", () => {
    const parsed = parseSampleCsv("code,name\nS1,甲\n\nS2,乙\n");
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 4]);
    expect(parsed.skippedBlankRows).toBe(1);

    const lines = ["code,name"];
    for (let index = 0; index < MAX_IMPORT_ROWS + 1; index += 1) {
      lines.push(`S${index},样品${index}`);
    }
    expect(parseSampleCsv(lines.join("\n")).error).toContain(String(MAX_IMPORT_ROWS));
  });
});

describe("sampleImportRowErrorText", () => {
  it("把可判别 code 翻成样品相关的中文原因", () => {
    expect(
      sampleImportRowErrorText({
        code: "INVALID_INPUT",
        message: "bad",
        issues: [
          {
            path: ["name"],
            code: "too_small",
            message: "String must contain at least 1 character(s)",
          },
        ],
      }),
    ).toBe("格式不对：品名必填");
    expect(
      sampleImportRowErrorText({ code: "DUPLICATE_IN_BATCH", message: "dup", conflictsWithRow: 0 }),
    ).toContain("第 2 行重复");
    expect(
      sampleImportRowErrorText({ code: "DUPLICATE_IN_DB", message: "dup", existingId: "id" }),
    ).toContain("已经存在");
  });

  it("单位/状态枚举错误给出可选值，而不是裸枚举", () => {
    expect(
      sampleImportRowErrorText({
        code: "INVALID_INPUT",
        message: "bad",
        issues: [{ path: ["unit"], code: "invalid_enum_value", message: "Invalid enum value" }],
      }),
    ).toContain("米 / 公斤 / 码 / 件");
  });
});

describe("parseCsvRecords 与样品导入共用", () => {
  it("引号里的逗号不拆列", () => {
    expect(parseCsvRecords('code,name\nS1,"棉,混纺"\n')[1]).toEqual(["S1", "棉,混纺"]);
  });
});
