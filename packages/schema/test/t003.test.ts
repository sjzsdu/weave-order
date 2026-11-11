import { describe, expect, it } from "vitest";
import {
  T003GetCustomerHistoryInput,
  T003GetCustomerHistoryResult,
} from "../src/tools/t003-get-customer-history";
import { makeCustomer, makeCustomerContext, makeQuoteSummary, UUID_A } from "./helpers";

describe("T-003 get_customer_history", () => {
  it("接受合法的 customerId，并填充默认 limit", () => {
    const r = T003GetCustomerHistoryInput.safeParse({ customerId: UUID_A });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(20);
    }
  });

  it("拒绝非 UUID 的 customerId（失败可判别）", () => {
    const r = T003GetCustomerHistoryInput.safeParse({ customerId: "not-a-uuid" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.code).toBe("invalid_string");
    }
  });

  it("拒绝非正整数的 limit", () => {
    const r = T003GetCustomerHistoryInput.safeParse({ customerId: UUID_A, limit: -1 });
    expect(r.success).toBe(false);
  });

  it("接受结构完整的历史数据（成功分支）", () => {
    const result = {
      ok: true,
      data: {
        customer: makeCustomer(),
        context: makeCustomerContext(),
        recentQuotes: [makeQuoteSummary()],
        recentOrders: [],
        recentSamples: [],
      },
    };
    const parsed = T003GetCustomerHistoryResult.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.ok) {
      expect(parsed.data.data.customer.name).toBe("杭州织造有限公司");
    }
  });

  it("接受带业务错误的失败分支（CUSTOMER_NOT_FOUND）", () => {
    const result = {
      ok: false,
      error: {
        code: "CUSTOMER_NOT_FOUND",
        message: "客户不存在",
        customerId: UUID_A,
      },
    };
    const parsed = T003GetCustomerHistoryResult.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success && !parsed.data.ok) {
      expect(parsed.data.error.code).toBe("CUSTOMER_NOT_FOUND");
    }
  });

  it("拒绝未知错误码（失败语义必须是封闭集合）", () => {
    const result = {
      ok: false,
      error: { code: "SOMETHING_ELSE", message: "未知" },
    };
    expect(T003GetCustomerHistoryResult.safeParse(result).success).toBe(false);
  });
});
