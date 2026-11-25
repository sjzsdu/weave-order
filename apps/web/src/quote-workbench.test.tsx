import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QuoteBasis } from "@weave-order/schema";
import { QuoteBasisCard } from "./quote-workbench";

const money = (amount: number) => ({ amount, currency: "CNY" as const });

const basis = (floorSource: string): QuoteBasis => ({
  quoteId: "5f0e5b7e-9f6a-4c2e-9b0c-3c9b1a2d4e5f",
  itemId: null,
  currency: "CNY",
  generatedAt: "2026-11-24T00:00:00.000Z",
  lines: [
    {
      lineIndex: 0,
      sampleId: "6a1f2c3d-4b5e-4f70-8a91-b2c3d4e5f601",
      sampleCode: "E2E-FAB-c6flab13-01",
      sampleName: "全棉府绸",
      quantity: { value: 100, unit: "meter" },
      unitPrice: money(1500),
      lineTotal: money(150000),
      sampleCostFloor: money(1000),
      companyCostFloor: money(1050),
      priceFloor: money(1200),
      minMarginPct: 10,
      marginAmount: money(300),
      marginBps: 2000,
      floorSource,
    },
  ],
  history: [],
  lastDealUnitPrice: null,
  lastDealAt: null,
});

const render = (floorSource: string) =>
  renderToStaticMarkup(
    <QuoteBasisCard
      basis={basis(floorSource)}
      baselineTotal={money(150000)}
      currentTotal={money(150000)}
      pendingDiff={[]}
    />,
  );

describe("报价详情·报价依据", () => {
  it("出处行与事项详情同一句人话，不露数据库字段", () => {
    const html = render(
      "samples.cost_floor(E2E-FAB-c6flab13-01) + pricing_policies.min_margin_pct (SYSTEM)",
    );
    expect(html).toContain("样品成本底线");
    expect(html).toContain("最低毛利规则");
    expect(html).toContain("系统默认");
    expect(html).not.toMatch(/samples\.cost_floor|pricing_policies|SYSTEM/);
  });

  it("后端实际输出的全角括号与作用域枚举也翻译", () => {
    const html = render("samples.cost_floor(S01) + pricing_policies.min_margin_pct（COMPANY）");
    expect(html).toContain("样品成本底线 + 最低毛利规则（公司）");
    expect(html).not.toMatch(/samples\.cost_floor|pricing_policies|COMPANY/);
  });

  it("未知来源原样保留，不伪装成没有依据", () => {
    const html = render("manual.override");
    expect(html).toContain("manual.override");
  });
});
