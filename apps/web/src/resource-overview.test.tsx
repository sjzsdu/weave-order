import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ResourceOverview } from "@weave-order/schema";
import { buildCategoryDistribution, ResourceOverviewView } from "./resource-overview";

vi.mock("@/can", () => ({
  Can: ({ children }: { children: ReactNode }) => children,
}));

const DATA: ResourceOverview = {
  generatedAt: "2026-11-22T00:00:00.000Z",
  customers: {
    total: 10,
    tiers: [
      { code: "VIP", count: 6 },
      { code: "NEW", count: 4 },
    ],
  },
  samples: {
    available: 20,
    draft: 2,
    archived: 1,
    categories: [
      { code: "KNIT", count: 5 },
      { code: "WOVEN", count: 4 },
      { code: "PRINT", count: 3 },
      { code: "TERRY", count: 2 },
      { code: "DENIM", count: 1 },
      { code: "FUNCTION", count: 3 },
      { code: null, count: 2 },
    ],
    completeness: [
      { key: "composition", completeCount: 15, missingCount: 5 },
      { key: "weight", completeCount: 20, missingCount: 0 },
      { key: "width", completeCount: 10, missingCount: 10 },
      { key: "primaryImage", completeCount: 5, missingCount: 15 },
    ],
  },
};

describe("资源概览展示", () => {
  it("品类只展开前五项，其余合并为其他，并映射自定义名称和回退 code", () => {
    const rows = buildCategoryDistribution(DATA.samples.categories, DATA.samples.available, {
      KNIT: "针织精品",
    });

    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ label: "针织精品", count: 5, percentage: 25 });
    expect(rows[1]).toMatchObject({ label: "WOVEN", count: 4, percentage: 20 });
    expect(rows.at(-1)).toMatchObject({ label: "其他", count: 5, percentage: 25 });
    expect(rows.some((row) => row.label === "FUNCTION")).toBe(false);
  });

  it("图表和摘要同时提供数量、百分比与完整度文本", () => {
    const html = renderToStaticMarkup(
      <ResourceOverviewView
        data={DATA}
        templateCount={3}
        categoryLabels={{ KNIT: "针织精品" }}
        tierLabels={{ VIP: "战略客户" }}
      />,
    );

    expect(html).toContain("资源概览");
    expect(html).toContain("20 个可用样品");
    expect(html).toContain("3 个模板");
    expect(html).toContain("报价工作台");
    expect(html).toContain("订单跟踪");
    expect(html).toContain("针织精品");
    expect(html).toContain("战略客户");
    expect(html).toContain("6 个 · 60%");
    expect(html).toContain("完整 15 / 20 · 75%");
    expect(html).toContain("缺少 5 个");
    expect(html).toContain('role="img"');
    expect(html).toContain("可用样品品类分布");
    expect(html).not.toContain("最近审计（只追加）");
  });

  it("空数据展示明确空状态，不产生 NaN", () => {
    const empty: ResourceOverview = {
      ...DATA,
      customers: { total: 0, tiers: [] },
      samples: {
        available: 0,
        draft: 0,
        archived: 0,
        categories: [],
        completeness: [
          { key: "composition", completeCount: 0, missingCount: 0 },
          { key: "weight", completeCount: 0, missingCount: 0 },
          { key: "width", completeCount: 0, missingCount: 0 },
          { key: "primaryImage", completeCount: 0, missingCount: 0 },
        ],
      },
    };
    const html = renderToStaticMarkup(<ResourceOverviewView data={empty} templateCount={0} />);

    expect(html).toContain("还没有可用样品");
    expect(html).toContain("还没有客户档案");
    expect(html).toContain("暂无完整度数据");
    expect(html).not.toContain("NaN");
  });
});
