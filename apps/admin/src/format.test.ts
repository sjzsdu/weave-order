import { describe, expect, it } from "vitest";
import { bps, money, percent, statusClass, wan } from "./format";

describe("平台控制台格式化", () => {
  it("金额按整数分渲染", () => {
    expect(money(49900)).toBe("¥499.00");
    expect(money(0)).toBe("¥0.00");
    expect(money(-1234)).toBe("-¥12.34");
  });

  it("万单位用于 MRR/ARR", () => {
    expect(wan(12_345_600)).toBe("¥12.3 万");
  });

  it("百分比与基点", () => {
    expect(percent(0.206)).toBe("20.6%");
    expect(bps(600)).toBe("6.00%");
  });

  it("状态样式按语义分档", () => {
    expect(statusClass("ACTIVE")).toBe("badge badge-ok");
    expect(statusClass("TRIAL")).toBe("badge badge-warn");
    expect(statusClass("SUSPENDED")).toBe("badge badge-danger");
  });
});
