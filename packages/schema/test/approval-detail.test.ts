import { describe, expect, it } from "vitest";
import { ApprovalDetail } from "../src";
import { NOW, UUID_A, UUID_B, makeCustomer } from "./helpers";

const item = {
  id: UUID_B,
  kind: "quote" as const,
  title: "报价 · 测试客户",
  summary: "500 米 × ¥15.20",
  status: "DRAFT" as const,
  pending: true,
  amountCents: 760000,
  currency: "CNY" as const,
  customerId: UUID_A,
  createdAt: NOW,
  confirmedBy: null,
};

const detail = {
  item,
  customer: makeCustomer(),
  draft: { state: "DRAFT" as const, version: 2, revisedByHuman: true, revisionCount: 1 },
  lines: [
    {
      id: "line-1",
      description: "32S 精梳棉汗布",
      quantity: { value: 500, unit: "meter" as const },
      unitPrice: { amount: 1520, currency: "CNY" as const },
      lineTotal: { amount: 760000, currency: "CNY" as const },
    },
  ],
  subtotal: { amount: 760000, currency: "CNY" as const },
  total: { amount: 760000, currency: "CNY" as const },
  currency: "CNY" as const,
  provenance: [
    {
      id: "cost",
      kind: "COST" as const,
      label: "成本底线",
      value: "¥14.20",
      detail: null,
      sourceRef: null,
    },
  ],
  diffs: [{ field: "第 1 行单价", before: 1560, after: 1520 }],
  missingFields: [{ field: "deliveryDate", label: "交期", hint: null }],
  risk: { level: "MEDIUM" as const, reasons: ["距成本底线 7%"] },
  audit: [],
};

describe("审批卡详情契约（出处 + diff + 草稿态）", () => {
  it("接受完整的只读详情", () => {
    expect(ApprovalDetail.safeParse(detail).success).toBe(true);
  });

  it("拒绝缺字段的详情（前端不得自行补算）", () => {
    const { total: _total, ...withoutTotal } = detail;
    expect(ApprovalDetail.safeParse(withoutTotal).success).toBe(false);
  });

  it("拒绝未知状态与夹带字段", () => {
    expect(
      ApprovalDetail.safeParse({ ...detail, draft: { ...detail.draft, state: "AI_APPROVED" } })
        .success,
    ).toBe(false);
    expect(ApprovalDetail.safeParse({ ...detail, writable: true }).success).toBe(false);
  });
});
