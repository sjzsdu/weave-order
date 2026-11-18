import { describe, expect, it } from "vitest";
import { escapeLikePattern, tokenizeSearchQuery } from "../src/kernel/search.service";

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

describe("T-002 检索词分词（成分 + 克重组合不再整串匹配）", () => {
  it("按空格与中文标点拆分", () => {
    expect(tokenizeSearchQuery("聚酯纤维 150g")).toEqual(["聚酯纤维", "150g"]);
    expect(tokenizeSearchQuery("聚酯纤维，150g")).toEqual(["聚酯纤维", "150g"]);
    expect(tokenizeSearchQuery("  棉   220g  ")).toEqual(["棉", "220g"]);
  });

  it("中文与数字连写时在交界处拆开", () => {
    expect(tokenizeSearchQuery("聚酯纤维150g")).toEqual(["聚酯纤维", "150g"]);
    expect(tokenizeSearchQuery("棉220g")).toEqual(["棉", "220g"]);
  });

  it("单个关键词与带特殊字符的编号保持原样", () => {
    expect(tokenizeSearchQuery("100%棉")).toEqual(["100%棉"]);
    expect(tokenizeSearchQuery("SMP%")).toEqual(["SMP%"]);
    expect(tokenizeSearchQuery("_")).toEqual(["_"]);
    expect(tokenizeSearchQuery("220g/m2")).toEqual(["220g/m2"]);
  });

  it("重复词元只保留一次，纯空白得到空数组", () => {
    expect(tokenizeSearchQuery("棉 棉 220g")).toEqual(["棉", "220g"]);
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });
});
