import { describe, expect, it } from "vitest";
import { describeJsonError, locate } from "./json-error";

describe("JSON 解析错误转中文", () => {
  it("V8 的 property name 报错带行列与修复动作", () => {
    const value = "{not json";
    let cause: unknown;
    try {
      JSON.parse(value);
    } catch (error) {
      cause = error;
    }
    const message = describeJsonError(value, cause);
    expect(message).toMatch(/^JSON 格式错误：第 1 行第 2 列/);
    expect(message).toContain("属性名必须用英文双引号包裹");
    expect(message).not.toMatch(/Expected|position/);
  });

  it("内容提前结束提示缺少括号", () => {
    expect(describeJsonError('{"a": 1', new SyntaxError("Unexpected end of JSON input"))).toBe(
      "JSON 格式错误：内容提前结束，缺少 } 或 ]",
    );
  });

  it("空值提示填写示例", () => {
    expect(describeJsonError("   ", new SyntaxError("Unexpected end of JSON input"))).toBe(
      "JSON 格式错误：第 1 行第 1 列 —— 内容为空，请填写 JSON（例如 {}）",
    );
  });

  it("没有行列信息时按偏移计算（多行内容）", () => {
    expect(locate('{\n  "a": 1,\n  bad\n}', 14)).toEqual({ line: 3, column: 3 });
    expect(
      describeJsonError(
        '{\n  "a": 1,\n  bad\n}',
        new SyntaxError("Unexpected token b in JSON at position 14"),
      ),
    ).toBe("JSON 格式错误：第 3 行第 3 列 —— 出现无法识别的字符");
  });
});
