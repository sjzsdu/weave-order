import { describe, expect, it } from "vitest";
import type { Customer } from "@weave-order/schema";
import { parseCustomerText, yuanInputToCents } from "../src/lib/parse-customer-text";

const CUSTOMERS: Customer[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "00000000-0000-4000-8000-000000000001",
    code: "C-1001",
    name: "青禾服饰",
    tier: "VIP",
    contactName: "陈青",
    contactPhone: "13800138001",
    contactEmail: null,
  },
  {
    id: "11111111-1111-4111-8111-222222222222",
    tenantId: "00000000-0000-4000-8000-000000000001",
    code: "C-1002",
    name: "华瑞制衣",
    tier: "REGULAR",
    contactName: "王瑞",
    contactPhone: "13900139002",
    contactEmail: null,
  },
];

describe("parseCustomerText", () => {
  it("抽出数量、成分、克重与客户", () => {
    const parsed = parseCustomerText("青禾服饰要这款 220g 棉的，要 500 米，什么价？", CUSTOMERS);
    expect(parsed.customerId).toBe(CUSTOMERS[0]?.id);
    expect(parsed.quantity).toEqual({ value: 500, unit: "meter" });
    expect(parsed.composition).toBe("棉");
    expect(parsed.weight).toBe("220g");
    expect(parsed.query).toBe("棉 220g");
    expect(parsed.targetPriceCents).toBeNull();
    expect(parsed.missing).toContain("单价（可让报价助手建议）");
    expect(parsed.confidence).toBe("high");
  });

  it("识别目标价，但不会把 500 米误判成价格", () => {
    const parsed = parseCustomerText("华瑞要 300 米 涤棉 180g，15 块能做吗", CUSTOMERS);
    expect(parsed.customerName).toBe("华瑞制衣");
    expect(parsed.targetPriceCents).toBe(1500);
    expect(parsed.quantity).toEqual({ value: 300, unit: "meter" });
    expect(parsed.composition).toBe("涤棉");
    expect(parsed.weight).toBe("180g");
  });

  it("克重用中文单位也能识别", () => {
    const parsed = parseCustomerText("200 克 亚麻 做 100 码", CUSTOMERS);
    expect(parsed.weight).toBe("200g");
    expect(parsed.composition).toBe("亚麻");
    expect(parsed.quantity).toEqual({ value: 100, unit: "yard" });
  });

  it("信息很少时如实说缺什么，不编造", () => {
    const parsed = parseCustomerText("在吗", []);
    expect(parsed.confidence).toBe("low");
    expect(parsed.missing.length).toBeGreaterThanOrEqual(3);
    expect(parsed.query).toBe("在吗");
  });

  it("长客户名优先匹配，避免短名误命中", () => {
    const parsed = parseCustomerText("青禾服饰的订单", CUSTOMERS);
    expect(parsed.customerName).toBe("青禾服饰");
  });
});

describe("yuanInputToCents", () => {
  it("按分取整，不用浮点直接算金额", () => {
    expect(yuanInputToCents("15.2")).toBe(1520);
    expect(yuanInputToCents("0.07")).toBe(7);
    expect(yuanInputToCents("15.234")).toBeNull();
    expect(yuanInputToCents("abc")).toBeNull();
    expect(yuanInputToCents("-1")).toBeNull();
  });
});
