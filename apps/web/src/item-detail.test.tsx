import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ItemDetailPage from "../app/(desktop)/items/[id]/page";

const mocks = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  mutations: [] as Array<Record<string, unknown>>,
  api: { undoItemTransition: vi.fn(), quoteBasis: vi.fn() },
  invalidate: vi.fn(),
  setQuery: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "item-1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/providers", () => ({ useApi: () => mocks.api }));
vi.mock("@weave-order/core", () => ({
  useTenantContext: () => ({ status: "READY", membership: { subject: "me" } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) =>
    mocks.queries.get(JSON.stringify(options.queryKey)) ?? {},
  useMutation: (options: Record<string, unknown>) => {
    mocks.mutations.push(options);
    return { isPending: false, mutate: vi.fn() };
  },
  useQueryClient: () => ({ setQueryData: mocks.setQuery, invalidateQueries: mocks.invalidate }),
}));
const detail = {
  item: {
    id: "item-1",
    status: "IN_PROGRESS",
    quantityMilli: 1000,
    unit: "meter",
    currentStage: "核对价格",
    nextAction: "确认价格",
  },
  customer: { id: "c1", code: "C01", name: "客户" },
  sample: { id: "s1", code: "S01", name: "全棉" },
  allowedTransitions: ["WAITING_INPUT", "WAITING_DECISION", "COMPLETED", "CLOSED"],
};
const money = (amount: number) => ({ amount, currency: "CNY" });
const basis = {
  lastDealUnitPrice: money(1400),
  lastDealAt: "2026-11-01T00:00:00Z",
  lines: [
    {
      lineIndex: 0,
      sampleCode: "S01",
      sampleName: "全棉",
      unitPrice: money(1500),
      sampleCostFloor: money(1000),
      priceFloor: money(1200),
      marginBps: 3333,
      floorSource: "样品成本 + 公司最低毛利",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.clear();
  mocks.mutations.length = 0;
  mocks.queries.set('["item","item-1"]', { data: detail });
  mocks.queries.set('["item","item-1","quotes"]', {
    data: { quotes: [{ id: "q1", status: "SENT", quoteNumber: "Q01", total: money(1500) }] },
  });
});

describe("事项决定面", () => {
  it("已确认报价在完成前就展示成本、底价、毛利和历史参考", () => {
    mocks.queries.set('["quote","q1","basis"]', { data: basis });
    const html = renderToStaticMarkup(<ItemDetailPage />);
    for (const text of [
      "定价依据",
      "样品成本底线",
      "含最低毛利的底价",
      "33.3%",
      "底价来源",
      "历史成交参考",
      "S01",
      "全棉",
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/undoToken|marginBps|WAITING_INPUT/);
  });

  it("数据库定价出处翻译为业务文案", () => {
    mocks.queries.set('["quote","q1","basis"]', {
      data: {
        ...basis,
        lines: [
          {
            ...basis.lines[0],
            floorSource: "samples.cost_floor(S01) + pricing_policies.min_margin_pct（SYSTEM）",
          },
        ],
      },
    });
    const html = renderToStaticMarkup(<ItemDetailPage />);
    expect(html).toContain("样品成本底线 + 最低毛利规则（系统默认）");
    expect(html).not.toMatch(/samples\.cost_floor|pricing_policies|SYSTEM/);
  });

  it("无历史成交则隐藏历史行", () => {
    mocks.queries.set('["quote","q1","basis"]', {
      data: { ...basis, lastDealUnitPrice: null, lastDealAt: null },
    });
    expect(renderToStaticMarkup(<ItemDetailPage />)).not.toContain("历史成交参考");
  });

  it("依据失败时静默隐藏，完成与等待操作仍存在", () => {
    mocks.queries.set('["quote","q1","basis"]', {
      isError: true,
      error: new Error("依据读取失败"),
    });
    const html = renderToStaticMarkup(<ItemDetailPage />);
    expect(html).not.toContain("定价依据");
    expect(html).not.toContain("依据读取失败");
    for (const text of ["标记完成", "等我补资料", "等我决定"]) expect(html).toContain(text);
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
  });

  it("撤销将票据交给现有 client 并刷新详情与列表", async () => {
    renderToStaticMarkup(<ItemDetailPage />);
    const undo = mocks.mutations[0] as {
      mutationFn: (token: string) => Promise<unknown>;
      onSuccess: () => void;
    };
    await undo.mutationFn("signed-token");
    expect(mocks.api.undoItemTransition).toHaveBeenCalledWith("item-1", {
      undoToken: "signed-token",
    });
    undo.onSuccess();
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["item", "item-1"] });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["items"] });
  });
});
