import { describe, expect, it } from "vitest";
import { EMPTY_CUSTOMER_DRAFT, customerSubmitError, validateCustomerDraft } from "./customer-form";

describe("validateCustomerDraft", () => {
  it("客户名 + 第一位联系人姓名必填（等级默认新客）", () => {
    expect(validateCustomerDraft({ ...EMPTY_CUSTOMER_DRAFT, name: "杭州青禾" }).contactName).toBe(
      "请先填第一位联系人的姓名",
    );
    expect(
      validateCustomerDraft({ ...EMPTY_CUSTOMER_DRAFT, name: "杭州青禾", contactName: "周敏" }),
    ).toEqual({});
    expect(EMPTY_CUSTOMER_DRAFT.tier).toBe("NEW");
  });

  it("名字必填，且去掉首尾空格后再判断", () => {
    expect(validateCustomerDraft({ ...EMPTY_CUSTOMER_DRAFT, name: "   " }).name).toBe(
      "客户名称必填",
    );
  });

  it("可选字段只在有值时校验", () => {
    const errors = validateCustomerDraft({
      ...EMPTY_CUSTOMER_DRAFT,
      name: "青禾",
      contactName: "周敏",
      contactPhone: "abc",
      contactEmail: "not-an-email",
    });
    expect(errors.contactPhone).toBeDefined();
    expect(errors.contactEmail).toBeDefined();
  });
});

describe("customerSubmitError", () => {
  it("编号冲突和未知失败都有人话", () => {
    expect(customerSubmitError(new Error("boom"))).toBe("boom");
    expect(customerSubmitError(null)).toContain("表单内容还在");
  });
});
