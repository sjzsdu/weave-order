import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalDetail } from "@weave-order/schema";
import { ApprovalSheet } from "../src/approval-sheet";
import { DraftCard } from "../src/draft-card";

const UUID_A = "123e4567-e89b-12d3-a456-426614174000";
const UUID_B = "123e4567-e89b-12d3-a456-426614174001";

const detail = ApprovalDetail.parse({
  item: {
    id: UUID_B,
    kind: "quote",
    title: "报价 · 青禾服饰",
    summary: "500 米 × ¥15.20",
    status: "DRAFT",
    pending: true,
    amountCents: 760000,
    currency: "CNY",
    customerId: UUID_A,
    createdAt: "2026-11-12T09:00:00.000Z",
    confirmedBy: null,
  },
  customer: {
    id: UUID_A,
    tenantId: UUID_B,
    code: "KH-018",
    name: "杭州青禾服饰",
    tier: "VIP",
    contactName: null,
    contactPhone: null,
    contactEmail: null,
  },
  draft: { state: "DRAFT", version: 2, revisedByHuman: true, revisionCount: 1 },
  lines: [
    {
      id: "line-1",
      description: "32S 精梳棉汗布",
      quantity: { value: 500, unit: "meter" },
      unitPrice: { amount: 1520, currency: "CNY" },
      lineTotal: { amount: 760000, currency: "CNY" },
    },
  ],
  subtotal: { amount: 760000, currency: "CNY" },
  total: { amount: 760000, currency: "CNY" },
  currency: "CNY",
  provenance: [
    {
      id: "cost",
      kind: "COST",
      label: "成本底线",
      value: "¥14.20",
      detail: "低于此线内核拒绝",
      sourceRef: null,
    },
  ],
  diffs: [{ field: "第 1 行单价", before: 1560, after: 1520 }],
  missingFields: [{ field: "deliveryDate", label: "交期", hint: "确认后完整" }],
  risk: { level: "MEDIUM", reasons: ["距成本底线 7%"] },
  audit: [],
});

describe("设计系统：草稿态与审批卡", () => {
  it("草稿卡带虚线边与版本号", () => {
    const html = renderToStaticMarkup(
      <DraftCard title="报价" state="draft" version={2}>
        <span>内容</span>
      </DraftCard>,
    );
    expect(html).toContain("border-dashed");
    expect(html).toContain("v2");
    expect(html).toContain("草稿");
  });

  it("审批卡展示金额、出处、diff、缺项与批准", () => {
    const html = renderToStaticMarkup(<ApprovalSheet detail={detail} onApprove={() => {}} />);
    expect(html).toContain("7,600.00");
    expect(html).toContain("成本底线");
    expect(html).toContain("改幅 diff");
    expect(html).toContain("缺 交期");
    expect(html).toContain("批准");
    expect(html).toContain("tabular-nums");
  });

  it("无权限 / 空详情显示可读的空态", () => {
    const html = renderToStaticMarkup(
      <ApprovalSheet detail={null} error="FORBIDDEN" />,
    );
    expect(html).toContain("暂时打不开");
  });
});
