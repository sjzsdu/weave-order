import { describe, expect, it } from "vitest";
import { itemQuantityText } from "./item-format";

describe("数量展示", () => {
  it("千分之一单位还原为米，缺失数量不显示成 0", () => {
    expect(itemQuantityText(1500, "meter")).toBe("1.5 米");
    expect(itemQuantityText(2_000_000, "kilogram")).toBe("2,000 千克");
    expect(itemQuantityText(null, "meter")).toBe("数量待补充");
  });
});
