import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, formatQuantity, lineLabel, validityRatio } from "../src/lib";
import { dict, nextLang } from "../src/i18n";

describe("客户报价页展示逻辑", () => {
  it("金额以整数分渲染为两位小数，且不丢分", () => {
    expect(formatMoney(760000, "CNY", "zh")).toContain("7,600.00");
    expect(formatMoney(1520, "CNY", "en")).toContain("15.20");
    expect(formatMoney(1, "USD", "en")).toContain("0.01");
  });

  it("数量按单位本地化，不做浮点拼接", () => {
    expect(formatQuantity(500, "meter", "zh")).toBe("500 米");
    expect(formatQuantity(120.5, "meter", "en")).toBe("120.5 m");
    expect(formatQuantity(2, "piece", "zh")).toBe("2 件");
  });

  it("有效期进度条夹在 0..1", () => {
    expect(validityRatio(-2)).toBe(0);
    expect(validityRatio(15)).toBeCloseTo(0.5);
    expect(validityRatio(90)).toBe(1);
  });

  it("中英切换与行号文案", () => {
    expect(dict("zh").accept).toBe("接受此报价");
    expect(dict("en").accept).toBe("Accept this quotation");
    expect(nextLang("zh")).toBe("en");
    expect(nextLang("en")).toBe("zh");
    expect(lineLabel(1, "zh")).toBe("第 2 行");
    expect(lineLabel(1, "en")).toBe("Line 2");
  });

  it("日期固定按上海时区展示，避免客户看到前一天", () => {
    expect(formatDate("2026-11-26T00:00:00.000Z", "zh")).toContain("2026");
    expect(formatDate("not-a-date", "zh")).toBe("not-a-date");
  });
});
