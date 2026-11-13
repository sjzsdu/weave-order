import { describe, expect, it } from "vitest";
import {
  actionOverageCents,
  annualToMonthlyCents,
  buildInvoiceLines,
  effectiveMonthlyCents,
  grossMarginBps,
  invoiceTotals,
  periodSeatChargeCents,
  quotaState,
} from "../src/domain/billing";
import { can, permissionsFor } from "../src/domain/permissions";

describe("控制面计费纯函数", () => {
  it("年付折算与席位费", () => {
    expect(annualToMonthlyCents(499000)).toBe(41583);
    expect(
      effectiveMonthlyCents({ monthlyPriceCents: 49900, annualPriceCents: 499000 }, "ANNUAL"),
    ).toBe(41583);
    expect(
      periodSeatChargeCents({ monthlyPriceCents: 49900, annualPriceCents: 499000 }, 20, "MONTHLY"),
    ).toBe(998000);
    expect(
      periodSeatChargeCents({ monthlyPriceCents: 49900, annualPriceCents: 499000 }, 20, "ANNUAL"),
    ).toBe(9_980_000);
  });

  it("价税分离四舍五入到分", () => {
    expect(invoiceTotals(100_00, 600)).toEqual({ taxCents: 600, totalCents: 10600 });
    expect(invoiceTotals(99_999, 600)).toEqual({ taxCents: 6000, totalCents: 105999 });
    expect(invoiceTotals(0, 1300)).toEqual({ taxCents: 0, totalCents: 0 });
  });

  it("agent 动作超额只对超出部分计价", () => {
    expect(actionOverageCents(5320, 5000)).toEqual({ overageActions: 320, overageCents: 1600 });
    expect(actionOverageCents(4000, 5000)).toEqual({ overageActions: 0, overageCents: 0 });
  });

  it("账单行包含席位费、超额与调整，且小计不为负", () => {
    const draft = buildInvoiceLines({
      seats: 20,
      seatUnitCents: 44900,
      billingCycle: "MONTHLY",
      usedActions: 5320,
      actionQuota: 5000,
      adjustments: [{ description: "首年折扣", amountCents: -100_00 }],
    });
    expect(draft.lineItems).toHaveLength(3);
    expect(draft.subtotalCents).toBe(898000 + 1600 - 10000);
    expect(() =>
      buildInvoiceLines({
        seats: 1,
        seatUnitCents: 100,
        billingCycle: "MONTHLY",
        usedActions: 0,
        actionQuota: 100,
        adjustments: [{ description: "错账", amountCents: -100000 }],
      }),
    ).toThrow("账单小计不能为负");
  });

  it("额度分档：80% 提醒、100% 停新任务、110% 拒绝", () => {
    expect(quotaState(100, 1000)).toBe("OK");
    expect(quotaState(800, 1000)).toBe("WARN");
    expect(quotaState(1000, 1000)).toBe("BLOCK_NEW");
    expect(quotaState(1100, 1000)).toBe("REJECT");
    expect(quotaState(999, 0)).toBe("OK");
  });

  it("毛利基点", () => {
    expect(grossMarginBps(100_000, 15_000)).toBe(8500);
    expect(grossMarginBps(0, 1000)).toBe(0);
  });
});

describe("平台权限矩阵", () => {
  it("只在服务端矩阵判定，角色最小 5 个", () => {
    expect(can("platform_owner", "tenant:purge")).toBe(true);
    expect(can("platform_finance", "invoice:issue")).toBe(true);
    expect(can("platform_finance", "tenant:write")).toBe(false);
    expect(can("platform_support", "tenant:read")).toBe(true);
    expect(can("platform_support", "tenant:write")).toBe(false);
    expect(can("platform_ops", "config:write")).toBe(true);
    expect(can("platform_ops", "billing:write")).toBe(false);
    expect(can("platform_readonly", "tenant:write")).toBe(false);
    expect(can("platform_readonly", "audit:read")).toBe(true);
    expect(permissionsFor("platform_owner").length).toBeGreaterThan(
      permissionsFor("platform_finance").length,
    );
  });
});
