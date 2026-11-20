import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerListItem } from "@weave-order/schema";
import {
  followupSummary,
  needsFollowup,
  pendingAmountText,
  tierLabel,
} from "../src/lib/customer-row";

const NOW = new Date("2026-11-20T02:00:00.000Z");

function item(overrides: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    code: "KH-001",
    name: "杭州青禾服饰",
    tier: "VIP",
    status: "AVAILABLE",
    contactName: "周敏",
    contactPhone: "13800000000",
    contactEmail: null,
    ownerId: null,
    ownerName: null,
    pendingQuoteCount: 0,
    pendingQuoteAmount: [],
    inTransitSampleCount: 0,
    activeOrderCount: 0,
    receivableBalance: [],
    overdueReceivableCount: 0,
    lastContactAt: null,
    contactWechat: null,
    ...overrides,
  };
}

describe("客户列表行文案", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("未决金额按币种展示，空数组显示无未决", () => {
    expect(pendingAmountText([])).toBe("无未决");
    expect(
      pendingAmountText([
        { amount: 760_000, currency: "CNY" },
        { amount: 12_000, currency: "USD" },
      ]),
    ).toBe("¥7,600 / $120");
  });

  it("待跟进行优先展示未决金额与张数", () => {
    const summary = followupSummary(
      item({
        pendingQuoteCount: 2,
        pendingQuoteAmount: [{ amount: 760_000, currency: "CNY" }],
        lastContactAt: new Date("2026-11-17T02:00:00.000Z").toISOString(),
      }),
    );
    expect(summary).toBe("未决 ¥7,600 · 2 张 · 最近 3 天前");
    expect(needsFollowup(item({ pendingQuoteCount: 2 }))).toBe(true);
  });

  it("没有未决时退到逾期应收，再退到最近往来", () => {
    expect(
      followupSummary(
        item({
          overdueReceivableCount: 1,
          lastContactAt: new Date("2026-11-19T02:00:00.000Z").toISOString(),
        }),
      ),
    ).toBe("逾期应收 1 笔 · 最近 1 天前");
    expect(
      followupSummary(item({ lastContactAt: new Date("2026-11-19T23:00:00.000Z").toISOString() })),
    ).toBe("最近往来 3 小时前");
    expect(followupSummary(item())).toBe("还没有往来");
    expect(needsFollowup(item())).toBe(false);
  });

  it("等级用中文标签，自定义等级原样显示", () => {
    expect(tierLabel("VIP")).toBe("VIP");
    expect(tierLabel("NEW")).toBe("新客");
    expect(tierLabel("T-2026-01")).toBe("T-2026-01");
  });
});
