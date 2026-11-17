import { describe, expect, it } from "vitest";
import { describeValidity, summaryText, type ControlSnapshot } from "./form-validation";

const valid = {
  valueMissing: false,
  typeMismatch: false,
  patternMismatch: false,
  tooShort: false,
  tooLong: false,
  rangeUnderflow: false,
  rangeOverflow: false,
  stepMismatch: false,
  badInput: false,
  customError: false,
};

function snapshot(overrides: Partial<ControlSnapshot> = {}): ControlSnapshot {
  return {
    name: "name",
    label: "公司名称",
    type: "text",
    validity: { ...valid },
    ...overrides,
  };
}

describe("字段级错误文案", () => {
  it("必填为空时给出中文字段名与修复动作", () => {
    expect(describeValidity(snapshot({ validity: { ...valid, valueMissing: true } }))).toBe(
      "请填写「公司名称」",
    );
  });

  it("复选框未勾选时提示勾选", () => {
    expect(
      describeValidity(
        snapshot({
          label: "租户同意",
          type: "checkbox",
          validity: { ...valid, valueMissing: true },
        }),
      ),
    ).toBe("请勾选「租户同意」后再提交");
  });

  it("邮箱格式错误给出示例", () => {
    expect(
      describeValidity(
        snapshot({
          label: "联系邮箱",
          type: "email",
          validity: { ...valid, typeMismatch: true },
        }),
      ),
    ).toBe("请输入形如 name@example.com 的邮箱地址");
  });

  it("pattern 不匹配时带上 title 里的格式说明", () => {
    expect(
      describeValidity(
        snapshot({
          label: "租户标识（slug）",
          title: "只允许小写字母、数字和连字符",
          validity: { ...valid, patternMismatch: true },
        }),
      ),
    ).toBe("「租户标识（slug）」格式不正确：只允许小写字母、数字和连字符");
  });

  it("数值越界时说明上下限", () => {
    expect(
      describeValidity(
        snapshot({
          label: "试用天数",
          type: "number",
          max: "90",
          validity: { ...valid, rangeOverflow: true },
        }),
      ),
    ).toBe("「试用天数」不能大于 90");
  });

  it("合法字段返回 null", () => {
    expect(describeValidity(snapshot())).toBeNull();
  });
});

describe("错误汇总文案", () => {
  it("包含错误数量", () => {
    expect(summaryText(3)).toBe("请检查 3 项未填写或格式不正确的内容");
    expect(summaryText(0)).toBe("");
  });
});
