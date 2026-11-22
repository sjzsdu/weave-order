import { describe, expect, it } from "vitest";
import { sampleWeightText } from "@weave-order/schema";

describe("样品克重展示", () => {
  it("优先使用结构化的 weightGsm", () => {
    expect(sampleWeightText(150, "150")).toBe("150 g/m²");
  });

  it("老数据只有裸数字时补上单位，避免卡片一半有单位一半没有", () => {
    expect(sampleWeightText(null, "230")).toBe("230 g/m²");
    expect(sampleWeightText(undefined, " 230 ")).toBe("230 g/m²");
  });

  it("已经带单位的原文保持原样，不重复拼单位", () => {
    expect(sampleWeightText(null, "220g/m2")).toBe("220g/m2");
    expect(sampleWeightText(null, "32S/2")).toBe("32S/2");
  });

  it("没有克重时不制造数值", () => {
    expect(sampleWeightText(null, null)).toBeNull();
    expect(sampleWeightText(null, "   ")).toBeNull();
  });
});
