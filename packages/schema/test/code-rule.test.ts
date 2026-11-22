import { describe, expect, it } from "vitest";
import {
  CODE_ENTITY_MAX_BYTES,
  CODE_RULE_PRESETS,
  codeBucket,
  defaultCodeTemplate,
  parseCodeTemplate,
  previewCodeRule,
  renderCode,
  templateBudgetBytes,
  utf8Bytes,
  validateCodeTemplate,
} from "../src";

const NOW = new Date("2026-11-15T16:00:00.000Z"); // 北京时间已跨日为 11-16

describe("code-rule 模板解析", () => {
  it("识别字面量 / PREFIX / 日期 / SEQ 片段", () => {
    const result = parseCodeTemplate("KH-{YYYYMM}-{SEQ:4}");
    expect(result.errors).toEqual([]);
    expect(result.seqIndex).toBe(3);
    expect(result.segments).toEqual([
      { kind: "literal", value: "KH-" },
      { kind: "date", token: "YYYYMM" },
      { kind: "literal", value: "-" },
      { kind: "seq", width: 4 },
    ]);
  });

  it("拒绝未知占位符", () => {
    const result = parseCodeTemplate("C-{CUSTOMER_NAME}-{SEQ:4}");
    expect(result.errors.map((e) => e.code)).toContain("CODE_TEMPLATE_UNKNOWN_PLACEHOLDER");
  });

  it("SEQ 必须且只能出现一次", () => {
    expect(parseCodeTemplate("C{YYMMDD}").errors.map((e) => e.code)).toContain(
      "CODE_TEMPLATE_SEQ_REQUIRED",
    );
    expect(parseCodeTemplate("{SEQ:3}-{SEQ:3}").errors.map((e) => e.code)).toContain(
      "CODE_TEMPLATE_SEQ_MULTIPLE",
    );
  });

  it("纯 SEQ 无法分桶，拒绝", () => {
    expect(parseCodeTemplate("{SEQ:4}").errors.map((e) => e.code)).toContain(
      "CODE_TEMPLATE_NO_LITERAL",
    );
  });

  it("字面部分非 ASCII 拒绝", () => {
    expect(parseCodeTemplate("客户{SEQ:4}").errors.map((e) => e.code)).toContain(
      "CODE_TEMPLATE_NON_ASCII_LITERAL",
    );
  });

  it("SEQ 位数只在 1-8", () => {
    expect(
      parseCodeTemplate("C{SEQ:9}").errors.map((e) => e.code),
    ).toContain("CODE_TEMPLATE_UNKNOWN_PLACEHOLDER");
    expect(parseCodeTemplate("C{SEQ:8}").errors).toEqual([]);
  });
});

describe("code-rule 渲染", () => {
  it("按北京时间（固定 +8h）渲染日期", () => {
    expect(
      renderCode({ entityType: "customer", template: "C{YYMMDD}-{SEQ:4}", now: NOW, seq: 7 }),
    ).toBe("C261116-0007");
    expect(
      renderCode({ entityType: "sample", template: "S{YYYYMMDD}-{SEQ:4}", now: NOW, seq: 1 }),
    ).toBe("S20261116-0001");
  });

  it("PREFIX 用实体默认字头", () => {
    expect(
      renderCode({ entityType: "quote", template: "{PREFIX}{SEQ:5}", now: NOW, seq: 42 }),
    ).toBe("BJ00042");
    expect(
      renderCode({ entityType: "sample_shipment", template: "{PREFIX}{SEQ:5}", now: NOW, seq: 1 }),
    ).toBe("JY00001");
  });

  it("序号超过 n 位时自然进位，不截断", () => {
    expect(
      renderCode({ entityType: "customer", template: "C{SEQ:2}", now: NOW, seq: 10000 }),
    ).toBe("C10000");
  });

  it("分桶键 = 去掉序号后的字面部分", () => {
    expect(codeBucket({ entityType: "customer", template: "C{YYMMDD}-{SEQ:4}", now: NOW })).toBe(
      "C261116-",
    );
    expect(codeBucket({ entityType: "customer", template: "{PREFIX}{SEQ:5}", now: NOW })).toBe("C");
  });
});

describe("code-rule 宽度与校验", () => {
  it("容量预算按 SEQ n+1 位估算", () => {
    // "C" + 6 位日期 + "-" + 5 位序号 = 13
    expect(templateBudgetBytes("C{YYMMDD}-{SEQ:4}")).toBe(13);
  });

  it("样品上限 32 字节，超预算模板被拒", () => {
    expect(CODE_ENTITY_MAX_BYTES.sample).toBe(32);
    const tooLong = `S{YYYYMMDD}-${"X".repeat(25)}{SEQ:4}`;
    expect(validateCodeTemplate(tooLong, "sample").map((e) => e.code)).toContain(
      "CODE_TEMPLATE_TOO_LONG",
    );
    expect(validateCodeTemplate(tooLong, "customer").map((e) => e.code)).not.toContain(
      "CODE_TEMPLATE_TOO_LONG",
    );
  });

  it("utf8Bytes 中文按 3 字节", () => {
    expect(utf8Bytes("中")).toBe(3);
    expect(utf8Bytes("ABC")).toBe(3);
  });

  it("预览返回示例 / 分桶 / 校验结果", () => {
    const result = previewCodeRule({ entityType: "customer", template: "C{YYMMDD}-{SEQ:4}" });
    expect(result.valid).toBe(true);
    expect(result.examples.length).toBe(3);
    expect(result.examples[0]?.code).toMatch(/^C\d{6}-0001$/);
    expect(result.bucket).toMatch(/^C\d{6}-$/);
    const bad = previewCodeRule({ entityType: "sample", template: "S-{UNKNOWN}-{SEQ:4}" });
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.code)).toContain("CODE_TEMPLATE_UNKNOWN_PLACEHOLDER");
  });
});

describe("code-rule 预设", () => {
  it("四套预设全部合法且覆盖五类实体", () => {
    for (const preset of CODE_RULE_PRESETS) {
      for (const [entityType, template] of Object.entries(preset.templates)) {
        expect(validateCodeTemplate(template, entityType as never)).toEqual([]);
      }
    }
  });

  it("默认预设 = classic，客户/样品格式与现状逐字节一致", () => {
    expect(defaultCodeTemplate("customer")).toBe("C{YYMMDD}-{SEQ:4}");
    expect(defaultCodeTemplate("sample")).toBe("S{YYMMDD}-{SEQ:4}");
  });
});
