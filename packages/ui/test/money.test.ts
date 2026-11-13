import { describe, expect, it } from "vitest";
import { formatCents, formatMoney } from "../src/money";

describe("金额展示（只格式化，不计算）", () => {
  it("整数分 → 两位小数", () => {
    expect(formatCents(180750, "CNY")).toContain("1,807.50");
    expect(formatCents(0, "CNY")).toContain("0.00");
  });

  it("负数保留符号", () => {
    expect(formatCents(-500, "USD").startsWith("-")).toBe(true);
  });

  it("空值显示占位符", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
  });
});
