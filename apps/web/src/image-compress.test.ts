import { describe, expect, it } from "vitest";
import { MAX_BYTES, MAX_EDGE, fitWithin, nextQuality } from "./image-compress";

/**
 * 桌面端压缩的纯函数契约：长边 ≤1600、按比例不裁切、质量阶梯收敛。
 * DOM 部分（canvas / objectURL）在浏览器里由 e2e 验证，不在 node 测试里伪造。
 */
describe("desktop image compression math", () => {
  it("长边超过 1600 时等比缩到 1600，短边按比例", () => {
    expect(fitWithin(3200, 2400)).toEqual({ width: MAX_EDGE, height: 1200 });
    expect(fitWithin(2400, 3200)).toEqual({ width: 1200, height: MAX_EDGE });
  });

  it("小图不放大", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("非法尺寸回落到 1x1，避免 canvas 宽高为 0", () => {
    expect(fitWithin(0, 1200)).toEqual({ width: 1, height: 1 });
  });

  it("质量阶梯单调下降且在预算内收敛到 0.4 附近", () => {
    let previous = 1;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const quality = nextQuality(attempt);
      expect(quality).toBeLessThanOrEqual(previous);
      expect(quality).toBeGreaterThanOrEqual(0.4);
      previous = quality;
    }
    expect(MAX_BYTES).toBe(1024 * 1024);
  });
});
