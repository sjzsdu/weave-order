import { afterEach, describe, expect, it } from "vitest";
import { UNIFIED_INPUT_PROMPT, unifiedInputHref } from "./unified-input";
import { itemQuantityText } from "./item-format";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_UNIFIED_INPUT_ROUTE;
});

describe("统一输入入口降级", () => {
  it("未配置统一输入页时回落到 /today?intent=（意图栏仍可用）", () => {
    expect(unifiedInputHref("建客户 张先生")).toBe(
      `/today?intent=${encodeURIComponent("建客户 张先生")}`,
    );
  });

  it("配置了统一输入路由后直接去该路由", () => {
    process.env.NEXT_PUBLIC_UNIFIED_INPUT_ROUTE = "/inbound";
    expect(unifiedInputHref("报价 500 米")).toBe(
      `/inbound?intent=${encodeURIComponent("报价 500 米")}`,
    );
  });

  it("空配置不产生双斜杠或空路由", () => {
    process.env.NEXT_PUBLIC_UNIFIED_INPUT_ROUTE = "   ";
    expect(unifiedInputHref("asdf").startsWith("/today?intent=")).toBe(true);
    expect(UNIFIED_INPUT_PROMPT.length).toBeGreaterThan(0);
  });
});

describe("数量展示", () => {
  it("千分之一单位还原为米，缺失数量不显示成 0", () => {
    expect(itemQuantityText(1500, "meter")).toBe("1.5 米");
    expect(itemQuantityText(2_000_000, "kilogram")).toBe("2,000 千克");
    expect(itemQuantityText(null, "meter")).toBe("数量待补充");
  });
});
