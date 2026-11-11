import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "../src/kernel/search.service";

describe("T-002 通配符转义（与 matchedOn 的字面 includes 语义对齐）", () => {
  it("转义 % / _ / 反斜杠，其余字符原样保留", () => {
    expect(escapeLikePattern("100%棉")).toBe("100\\%棉");
    expect(escapeLikePattern("SMP%")).toBe("SMP\\%");
    expect(escapeLikePattern("_")).toBe("\\_");
    expect(escapeLikePattern("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
  });

  it("真实纺织查法不被改写（中文/空格不受影响）", () => {
    expect(escapeLikePattern("100% 棉")).toBe("100\\% 棉");
    expect(escapeLikePattern("高支棉 220g/m2")).toBe("高支棉 220g/m2");
  });

  it("空字符串与普通关键词保持字面量", () => {
    expect(escapeLikePattern("")).toBe("");
    expect(escapeLikePattern("涤纶")).toBe("涤纶");
  });
});
