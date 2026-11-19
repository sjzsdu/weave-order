import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_OPTIONS,
  normalizeFieldValue,
  resolveFieldValue,
  generateTierCode,
} from "../src";
import type { FieldOptionLike } from "../src";

const TIERS: FieldOptionLike[] = [
  { fieldKey: "customer.tier", code: "NEW", label: "新客", normalized: "新客", active: true },
  { fieldKey: "customer.tier", code: "REGULAR", label: "常规", normalized: "常规", active: true },
  { fieldKey: "customer.tier", code: "VIP", label: "VIP", normalized: "vip", active: true },
  { fieldKey: "customer.tier", code: "COLD", label: "沉睡", normalized: "沉睡", active: false },
];

describe("normalizeFieldValue", () => {
  it("全角转半角并折叠空白", () => {
    expect(normalizeFieldValue("  ＰＯＬＹＥＳＴＥＲ　６５/３５  ")).toBe("polyester 65/35");
  });

  it("拉丁字母小写，中文与符号原样保留", () => {
    expect(normalizeFieldValue("Cotton 棉")).toBe("cotton 棉");
    expect(normalizeFieldValue("涤/棉")).toBe("涤/棉");
  });

  it("连续空白折叠成一个空格，全角空格同样处理", () => {
    expect(normalizeFieldValue("a \t\n\u3000b")).toBe("a b");
  });

  it("不改变非拉丁字母的大小写（避免看起来像另一个值）", () => {
    expect(normalizeFieldValue("СПБ")).toBe("СПБ");
  });
});

describe("resolveFieldValue", () => {
  it("按 label 归一化精确命中", () => {
    expect(resolveFieldValue("customer.tier", " vip ", TIERS)).toMatchObject({
      matched: true,
      code: "VIP",
      label: "VIP",
    });
  });

  it("等级可以用稳定 code 解析（CSV / 智能体给的是 code）", () => {
    expect(resolveFieldValue("customer.tier", "REGULAR", TIERS)).toMatchObject({
      matched: true,
      code: "REGULAR",
    });
  });

  it("未命中返回 null，由调用方决定新建", () => {
    expect(resolveFieldValue("customer.tier", "钻石客户", TIERS)).toMatchObject({
      matched: false,
      code: null,
      label: null,
    });
  });

  it("不做包含/模糊匹配（棉 不会错配到 棉混纺）", () => {
    const options: FieldOptionLike[] = [
      { fieldKey: "sample.composition", code: "C1", label: "棉混纺", normalized: "棉混纺" },
    ];
    expect(resolveFieldValue("sample.composition", "棉", options).matched).toBe(false);
  });

  it("已停用选项默认不参与解析，显式 includeInactive 才能命中", () => {
    expect(resolveFieldValue("customer.tier", "沉睡", TIERS).matched).toBe(false);
    expect(resolveFieldValue("customer.tier", "沉睡", TIERS, true)).toMatchObject({
      matched: true,
      code: "COLD",
    });
  });

  it("跨字段的选项不会互相命中（同名不同字段）", () => {
    const options: FieldOptionLike[] = [
      { fieldKey: "sample.category", code: "CAT-1", label: "涤纶", normalized: "涤纶" },
    ];
    expect(resolveFieldValue("customer.tier", "涤纶", options).matched).toBe(false);
  });
});

describe("预置项与自定义 code", () => {
  it("四个预置等级 code 沿用旧枚举值", () => {
    expect(DEFAULT_TIER_OPTIONS.map((option) => option.code)).toEqual([
      "NEW",
      "REGULAR",
      "VIP",
      "COLD",
    ]);
  });

  it("自定义等级 code 是 T- 前缀且不暗示顺序", () => {
    expect(generateTierCode(() => "ABCDEF123456")).toBe("T-ABCDEF123456");
    expect(generateTierCode()).toMatch(/^T-[A-Z0-9]+$/);
  });
});
