import { describe, expect, it } from "vitest";
import {
  formatCents,
  formatMoney,
  milliToQuantity,
  multiplyCents,
  quantityToMilli,
} from "../src/kernel/money";

describe("kernel 金额确定性运算", () => {
  it("数量按千分之一整数存储，往返无损", () => {
    expect(quantityToMilli(120.5)).toBe(120500);
    expect(milliToQuantity(120500)).toBe(120.5);
    expect(quantityToMilli(0.125)).toBe(125);
  });

  it("单价（分）× 数量 = 行金额（分），整数运算", () => {
    expect(multiplyCents(1500, 120500)).toBe(180750);
    expect(multiplyCents(1000, 100000)).toBe(100000);
  });

  it("结果按 half-up 舍入，不受浮点累积误差影响", () => {
    // 3 分/单位 × 0.333 单位 = 0.999 分 -> 1 分
    expect(multiplyCents(3, 333)).toBe(1);
    // 0.19 元/单位 × 3 单位 = 0.57 元
    expect(multiplyCents(19, 3000)).toBe(57);
  });

  it("金额格式化不丢分", () => {
    expect(formatCents(123456789)).toBe("1,234,567.89");
    expect(formatCents(5)).toBe("0.05");
    expect(formatMoney({ amount: 180750, currency: "CNY" })).toBe("CNY 1,807.50");
  });
});
