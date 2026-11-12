import type { Customer, ToolError } from "@weave-order/schema";
import { describe, expect, it } from "vitest";
import {
  customerName,
  formatCents,
  messageOf,
  shortId,
  statusBadgeClass,
  toolErrorText,
} from "./lib";

const customer: Customer = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  tenantId: "00000000-0000-0000-0000-000000000001",
  code: "C001",
  name: "杭州织造有限公司",
  tier: "VIP",
  contactName: null,
  contactPhone: null,
  contactEmail: null,
};

describe("web 展示辅助函数（纯函数，无 DOM / 无网络）", () => {
  it("金额（整数分）-> 展示字符串", () => {
    expect(formatCents(180750, "CNY")).toBe("CNY 1,807.50");
    expect(formatCents(0, "CNY")).toBe("CNY 0.00");
    expect(formatCents(-500, "USD")).toBe("-USD 5.00");
    expect(formatCents(30000000000, "CNY")).toBe("CNY 300,000,000.00");
  });

  it("shortId 截到 8 位", () => {
    expect(shortId("123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567");
  });

  it("customerName 从只读目录解析，找不到退回短 id", () => {
    expect(customerName([customer], customer.id)).toBe("杭州织造有限公司");
    expect(customerName([customer], "99999999-unknown")).toBe("99999999");
  });

  it("statusBadgeClass 按语义分色（字面量类串供 Tailwind 扫描）", () => {
    expect(statusBadgeClass("DRAFT")).toContain("warn");
    expect(statusBadgeClass("REJECTED")).toContain("danger");
    expect(statusBadgeClass("CANCELLED")).toContain("danger");
    expect(statusBadgeClass("SENT")).toContain("accent");
    expect(statusBadgeClass("CONFIRMED")).toContain("accent");
  });

  it("toolErrorText 如实呈现 INVALID_INPUT 与已知错误码", () => {
    const invalid: ToolError = {
      code: "INVALID_INPUT",
      message: "输入不合法",
      issues: [{ path: ["items", 0], code: "invalid_type", message: "必填" }],
    };
    expect(toolErrorText(invalid)).toContain("必填");
    const rejected: ToolError = {
      code: "KERNEL_REJECTED",
      message: "只有 DRAFT 可确认",
      reason: "INVALID_STATE_TRANSITION",
    };
    expect(toolErrorText(rejected)).toContain("KERNEL_REJECTED");
  });

  it("messageOf 提取 Error.message", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf("plain")).toBe("plain");
  });
});
