import { describe, expect, it } from "vitest";
import {
  QuoteListFilter,
  QuoteListResponse,
  UpdateTeamMemberInput,
} from "../src";

describe("报价工作台列表契约（WAN-175）", () => {
  it("筛选缺省 limit=50，不传 status 表示全部状态", () => {
    const parsed = QuoteListFilter.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.status).toBeUndefined();
  });

  it("拒绝非法状态与超长关键词", () => {
    expect(QuoteListFilter.safeParse({ status: "PAID" }).success).toBe(false);
    expect(QuoteListFilter.safeParse({ query: "x".repeat(201) }).success).toBe(false);
  });

  it("列表项必须带客户名与金额，避免前端再拼一份展示数据", () => {
    const response = QuoteListResponse.parse({
      items: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          customerId: "22222222-2222-4222-8222-222222222222",
          customerName: "杭州青禾服饰",
          status: "DRAFT",
          currency: "CNY",
          total: { amount: 120000, currency: "CNY" },
          version: 2,
          itemCount: 3,
          expiresAt: "2026-11-26T09:00:00.000Z",
          createdAt: "2026-11-12T09:00:00.000Z",
          updatedAt: "2026-11-12T09:00:00.000Z",
          pendingApproval: true,
        },
      ],
      nextCursor: null,
    });
    expect(response.items[0]?.customerName).toBe("杭州青禾服饰");
  });
});

describe("成员权限编辑契约", () => {
  it("至少改一项，不能提交空对象", () => {
    expect(UpdateTeamMemberInput.safeParse({}).success).toBe(false);
    expect(UpdateTeamMemberInput.safeParse({ dataScope: "TEAM" }).success).toBe(true);
  });

  it("审批额度只能是整数分或 null（null = 按角色规则）", () => {
    expect(UpdateTeamMemberInput.safeParse({ approvalLimitAmount: null }).success).toBe(true);
    expect(UpdateTeamMemberInput.safeParse({ approvalLimitAmount: 120000 }).success).toBe(true);
    expect(UpdateTeamMemberInput.safeParse({ approvalLimitAmount: 12.5 }).success).toBe(false);
    expect(UpdateTeamMemberInput.safeParse({ approvalLimitAmount: -1 }).success).toBe(false);
  });

  it("角色必须是既有枚举，不能自造", () => {
    expect(UpdateTeamMemberInput.safeParse({ role: "ADMIN" }).success).toBe(false);
    expect(UpdateTeamMemberInput.safeParse({ role: "VIEWER" }).success).toBe(true);
  });
});
