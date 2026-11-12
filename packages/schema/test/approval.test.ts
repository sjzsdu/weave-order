import { describe, expect, it } from "vitest";
import {
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalItem,
  ApprovalQueue,
  NO_TRACKING_NUMBER,
  PanoramaSnapshot,
} from "../src";
import { NOW, UUID_A, UUID_B, makeCustomer } from "./helpers";

const item = {
  id: UUID_B,
  kind: "quote" as const,
  title: "报价单 · 123e4567",
  summary: "1 行 · CNY 1,000.00",
  status: "DRAFT" as const,
  pending: true,
  amountCents: 100000,
  currency: "CNY" as const,
  customerId: UUID_A,
  createdAt: NOW,
  confirmedBy: null,
};

describe("审批 / 全景契约（第五步）", () => {
  it("缺运单号走明确业务错误码 NO_TRACKING_NUMBER", () => {
    expect(NO_TRACKING_NUMBER).toBe("NO_TRACKING_NUMBER");
  });

  it("ApprovalItem 接受合法的报价草稿视图", () => {
    expect(ApprovalItem.safeParse(item).success).toBe(true);
  });

  it("ApprovalItem 拒绝账本状态之外的状态（契约宁可拒）", () => {
    expect(ApprovalItem.safeParse({ ...item, status: "MADE_UP" }).success).toBe(false);
  });

  it("ApprovalItem 拒绝未知字段（strict）", () => {
    expect(ApprovalItem.safeParse({ ...item, writable: true }).success).toBe(false);
  });

  it("ApprovalQueue 只承载只读视图数组", () => {
    expect(ApprovalQueue.safeParse({ items: [item] }).success).toBe(true);
    expect(ApprovalQueue.safeParse({ items: [item], extra: 1 }).success).toBe(false);
  });

  it("ApprovalDecisionInput 拒绝未知决策与夹带账本字段", () => {
    expect(
      ApprovalDecisionInput.safeParse({ id: UUID_B, kind: "quote", decision: "APPROVE" }).success,
    ).toBe(true);
    expect(
      ApprovalDecisionInput.safeParse({ id: UUID_B, kind: "quote", decision: "MAYBE" }).success,
    ).toBe(false);
    expect(
      ApprovalDecisionInput.safeParse({
        id: UUID_B,
        kind: "quote",
        decision: "APPROVE",
        status: "SENT",
      }).success,
    ).toBe(false);
  });

  it("ApprovalDecisionResult 的失败分支沿用封闭 ToolError（未知 code 被拒）", () => {
    const okResult = ApprovalDecisionResult.safeParse({
      ok: true,
      data: {
        id: UUID_B,
        kind: "quote",
        decision: "APPROVE",
        status: "SENT",
        actorType: "HUMAN",
        decidedAt: NOW,
      },
    });
    expect(okResult.success).toBe(true);

    const rejection = ApprovalDecisionResult.safeParse({
      ok: false,
      error: { code: "KERNEL_REJECTED", message: "已处理", reason: "INVALID_STATE_TRANSITION" },
    });
    expect(rejection.success).toBe(true);

    const unknownCode = ApprovalDecisionResult.safeParse({
      ok: false,
      error: { code: "NOT_A_CODE", message: "未知" },
    });
    expect(unknownCode.success).toBe(false);
  });

  it("ApprovalDecisionResult 成功分支 actorType 必须是 HUMAN", () => {
    const result = ApprovalDecisionResult.safeParse({
      ok: true,
      data: {
        id: UUID_B,
        kind: "quote",
        decision: "APPROVE",
        status: "SENT",
        actorType: "AGENT",
        decidedAt: NOW,
      },
    });
    expect(result.success).toBe(false);
  });

  it("PanoramaSnapshot 是纯只读聚合结构", () => {
    const snapshot = PanoramaSnapshot.safeParse({
      generatedAt: NOW,
      customers: [makeCustomer()],
      samples: [],
      items: [item],
      audit: [],
      stats: {
        customerCount: 1,
        sampleCount: 0,
        quoteCount: 1,
        shipmentCount: 0,
        pendingCount: 1,
        sentQuoteCount: 0,
        confirmedShipmentCount: 0,
        rejectedCount: 0,
        auditCount: 0,
      },
    });
    expect(snapshot.success).toBe(true);
  });
});
