import { describe, expect, it } from "vitest";
import {
  T004GenerateQuoteDraftInput,
  T004GenerateQuoteDraftResult,
} from "../src/tools/t004-generate-quote-draft";
import { makeQuoteDraft, UUID_A, UUID_C } from "./helpers";

const validItem = {
  fabricSampleId: UUID_C,
  quantity: { value: 100, unit: "meter" as const },
  unitPrice: { amount: 1000, currency: "CNY" as const },
};

describe("T-004 generate_quote_draft", () => {
  it("接受合法的报价草稿输入", () => {
    const r = T004GenerateQuoteDraftInput.safeParse({
      customerId: UUID_A,
      items: [validItem],
      currency: "CNY",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.validityDays).toBe(30);
    }
  });

  it("拒绝空 items", () => {
    const r = T004GenerateQuoteDraftInput.safeParse({
      customerId: UUID_A,
      items: [],
      currency: "CNY",
    });
    expect(r.success).toBe(false);
  });

  it("拒绝浮点金额（金额必须是整数分，杜绝浮点精度）", () => {
    const r = T004GenerateQuoteDraftInput.safeParse({
      customerId: UUID_A,
      currency: "CNY",
      items: [
        {
          fabricSampleId: UUID_C,
          quantity: { value: 100, unit: "meter" },
          unitPrice: { amount: 10.5, currency: "CNY" },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("拒绝非正数量", () => {
    const r = T004GenerateQuoteDraftInput.safeParse({
      customerId: UUID_A,
      currency: "CNY",
      items: [
        {
          fabricSampleId: UUID_C,
          quantity: { value: 0, unit: "meter" },
          unitPrice: { amount: 1000, currency: "CNY" },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("接受由内核计算金额的报价草稿（amountsComputedByKernel 必须为 true）", () => {
    const result = { ok: true, data: { draft: makeQuoteDraft() } };
    const parsed = T004GenerateQuoteDraftResult.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("拒绝 amountsComputedByKernel 非 true 的草稿（金额来源不可判别即拒绝）", () => {
    const result = {
      ok: true,
      data: { draft: makeQuoteDraft({ amountsComputedByKernel: false as true }) },
    };
    expect(T004GenerateQuoteDraftResult.safeParse(result).success).toBe(false);
  });

  it("接受 KERNEL_REJECTED 失败（如单价低于成本线）", () => {
    const result = {
      ok: false,
      error: { code: "KERNEL_REJECTED", message: "内核拒绝", reason: "PRICE_BELOW_FLOOR" },
    };
    const parsed = T004GenerateQuoteDraftResult.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success && !parsed.data.ok) {
      expect(parsed.data.error.code).toBe("KERNEL_REJECTED");
    }
  });
});
