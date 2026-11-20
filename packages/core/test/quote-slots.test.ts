import { describe, expect, it } from "vitest";
import type { Customer } from "@weave-order/schema";
import { centsToYuanInput, parseCustomerText, yuanInputToCents } from "../src/quote-slots";

const CUSTOMERS: Customer[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "00000000-0000-4000-8000-000000000001",
    code: "C-1001",
    name: "青禾服饰",
    tier: "VIP",
    status: "AVAILABLE",
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
    status: "AVAILABLE",
    contactName: "王瑞",
    contactPhone: "13900139002",
    contactEmail: null,
  },
];

describe("报价槽位解析（桌面与移动共用）", () => {
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

  it("表单已选客户时，原话没提客户也不算缺失", () => {
    const parsed = parseCustomerText("要 300 米 涤棉 180g", CUSTOMERS, {
      selectedCustomerId: CUSTOMERS[1]?.id,
    });
    expect(parsed.customerId).toBeNull();
    expect(parsed.missing).not.toContain("客户");
    expect(parsed.hits.some((hit) => hit.includes("华瑞"))).toBe(true);
  });

  it("客户说简称时命中最长前缀", () => {
    const parsed = parseCustomerText("华瑞要 200 码亚麻", CUSTOMERS);
    expect(parsed.customerId).toBe(CUSTOMERS[1]?.id);
    expect(parsed.quantity).toEqual({ value: 200, unit: "yard" });
  });
});

describe("金额输入换算", () => {
  it("最多两位小数，非法输入返回 null 而不是猜一个数", () => {
    expect(yuanInputToCents("15.20")).toBe(1520);
    expect(yuanInputToCents("15.2")).toBe(1520);
    expect(yuanInputToCents("15.234")).toBeNull();
    expect(yuanInputToCents("-1")).toBeNull();
    expect(yuanInputToCents("abc")).toBeNull();
  });

  it("分转回输入框保留两位小数", () => {
    expect(centsToYuanInput(1520)).toBe("15.20");
    expect(centsToYuanInput(0)).toBe("0.00");
  });
});
