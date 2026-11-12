import { describe, expect, it } from "vitest";
import {
  MAX_BYTES,
  MAX_EDGE,
  fitWithin,
  isWithinBudget,
  nextQuality,
  QUALITY_LADDER,
} from "../src/lib/image-math";

describe("图片前置条件", () => {
  it("长边超限时等比缩到 1600，短边保持比例", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1200, 3200)).toEqual({ width: 600, height: 1600 });
  });

  it("小图不放大", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 600)).toEqual({ width: 0, height: 0 });
  });

  it("长边恰好等于上限时不动", () => {
    expect(fitWithin(MAX_EDGE, 900)).toEqual({ width: MAX_EDGE, height: 900 });
  });

  it("质量阶梯用尽后返回 null，调用方继续降分辨率", () => {
    expect(nextQuality(0)).toBe(QUALITY_LADDER[0]);
    expect(nextQuality(QUALITY_LADDER.length)).toBeNull();
  });

  it("1MB 是硬上限", () => {
    expect(isWithinBudget(MAX_BYTES)).toBe(true);
    expect(isWithinBudget(MAX_BYTES + 1)).toBe(false);
  });
});
