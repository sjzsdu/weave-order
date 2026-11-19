import { describe, expect, it } from "vitest";
import {
  CustomerContact,
  maskEmail,
  maskPhone,
  normalizePhone,
  pickDefaultContact,
} from "../src";

/**
 * 联系人纯函数（ADR §2.6 / §2.4）。
 * 这些规则同时被 API 读模型、桌面端和分享面板使用，任何一处漂移都会造成
 * 「列表里是掩码、导出却是明文」这类合规事故，所以独立成表驱动测试。
 */
describe("normalizePhone", () => {
  it("去掉空格 / 连字符 / 括号，保留前导 +", () => {
    expect(normalizePhone("138 0013-8000")).toBe("13800138000");
    expect(normalizePhone("+86 138-0013-8000")).toBe("+8613800138000");
    expect(normalizePhone("(0571) 8888 6666")).toBe("057188886666");
  });

  it("空值与不成号的输入返回 null（不参与唯一索引去重）", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("1234")).toBeNull();
  });
});

describe("maskPhone / maskEmail", () => {
  it("手机保留前 3 后 4", () => {
    expect(maskPhone("13800138000")).toBe("138****8000");
    expect(maskPhone("+86 13800138000")).toBe("861****8000");
  });

  it("邮箱只留首字母与域名", () => {
    expect(maskEmail("zhou@qinghe.com")).toBe("z***@qinghe.com");
    expect(maskEmail(null)).toBeNull();
  });

  it("空值 / 不成号的值不制造假掩码", () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("12345")).toBe("12345");
  });
});

describe("pickDefaultContact", () => {
  const contacts = [
    { id: "primary", role: "老板", isPrimary: true },
    { id: "buyer", role: "采购", isPrimary: false },
    { id: "finance", role: "财务", isPrimary: false },
    { id: "follow", role: "跟单", isPrimary: false },
  ];

  it("报价 / 催样找采购，对账找财务，寄样找跟单", () => {
    expect(pickDefaultContact(contacts, "quote")?.id).toBe("buyer");
    expect(pickDefaultContact(contacts, "sample_followup")?.id).toBe("buyer");
    expect(pickDefaultContact(contacts, "statement")?.id).toBe("finance");
    expect(pickDefaultContact(contacts, "shipment")?.id).toBe("follow");
  });

  it("角色归一化后匹配（全角 / 空格 / 大小写）", () => {
    expect(pickDefaultContact([{ id: "x", role: " 采购 ", isPrimary: false }], "quote")?.id).toBe(
      "x",
    );
  });

  it("找不到角色回退主联系人，没有主联系人回退第一位", () => {
    expect(pickDefaultContact([{ id: "only", role: null, isPrimary: true }], "statement")?.id).toBe(
      "only",
    );
    expect(pickDefaultContact([{ id: "first", role: null, isPrimary: false }], "quote")?.id).toBe(
      "first",
    );
    expect(pickDefaultContact([], "quote")).toBeNull();
  });
});

describe("CustomerContact 契约", () => {
  it("拒绝未知字段，避免把 phone_normalized 之类的内部列漏给前端", () => {
    const parsed = CustomerContact.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      tenantId: "22222222-2222-4222-8222-222222222222",
      customerId: "33333333-3333-4333-8333-333333333333",
      name: "周敏",
      role: "采购",
      phone: "138****8000",
      email: "z***@qinghe.com",
      wechat: null,
      note: null,
      isPrimary: true,
      archivedAt: null,
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
      phoneNormalized: "13800138000",
    });
    expect(parsed.success).toBe(false);
  });
});
