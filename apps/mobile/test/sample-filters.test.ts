import { describe, expect, it } from "vitest";
import {
  EMPTY_SAMPLE_FILTERS,
  activeFilterChips,
  buildSampleListQuery,
  emptyStateKind,
  hasActiveFilters,
  sampleCardMeta,
  toggleFacet,
} from "../src/lib/sample-filters";

/**
 * 样品筛选是服务端参数驱动的：页面状态一旦拼错，要么筛不出东西，要么把空串
 * 当成条件传给服务端。这层纯逻辑独立于 UI，先把参数形状钉死。
 */
describe("样品筛选参数", () => {
  it("空筛选只带状态与分页，不传空串", () => {
    const query = buildSampleListQuery("", EMPTY_SAMPLE_FILTERS, null);
    expect(query.query).toBeNull();
    expect(query.category).toBeNull();
    expect(query.composition).toBeNull();
    expect(query.weights).toBeNull();
    expect(query.status).toBe("ACTIVE");
    expect(query.limit).toBe(20);
  });

  it("关键词 trim 后传给服务端，克重档位按数组传", () => {
    const query = buildSampleListQuery(
      "  汗布 ",
      { category: "针织", composition: "100% 棉", weight: "220g/m2" },
      "cursor-1",
      40,
    );
    expect(query.query).toBe("汗布");
    expect(query.category).toBe("针织");
    expect(query.composition).toBe("100% 棉");
    // 服务端契约是逗号分隔的精确匹配，端上只单选一个档位。
    expect(query.weights).toEqual(["220g/m2"]);
    expect(query.cursor).toBe("cursor-1");
    expect(query.limit).toBe(40);
  });

  it("单选 chip 再点一次即取消，换一个则替换", () => {
    expect(toggleFacet(null, "针织")).toBe("针织");
    expect(toggleFacet("针织", "针织")).toBeNull();
    expect(toggleFacet("针织", "梭织")).toBe("梭织");
  });

  it("只有空白关键词不算筛选", () => {
    expect(hasActiveFilters("   ", EMPTY_SAMPLE_FILTERS)).toBe(false);
    expect(hasActiveFilters("", { ...EMPTY_SAMPLE_FILTERS, weight: "220g/m2" })).toBe(true);
    expect(hasActiveFilters("棉", EMPTY_SAMPLE_FILTERS)).toBe(true);
  });

  it("已选条件条用业务词，且按品类/成分/克重顺序", () => {
    expect(activeFilterChips({ category: "针织", composition: "棉", weight: "220g/m2" })).toEqual([
      { key: "category", label: "品类：针织" },
      { key: "composition", label: "成分：棉" },
      { key: "weight", label: "克重：220g/m2" },
    ]);
    expect(activeFilterChips(EMPTY_SAMPLE_FILTERS)).toEqual([]);
  });

  it("卡片底部一行：有克重显示编号 · 克重，没有则「规格未填」", () => {
    expect(sampleCardMeta({ code: "S-021", weight: "220g/m2" })).toBe("S-021 · 220g/m2");
    expect(sampleCardMeta({ code: "S-024", weight: null })).toBe("S-024 · 规格未填");
    expect(sampleCardMeta({ code: "S-025", weight: "  " })).toBe("S-025 · 规格未填");
  });

  it("空态分两种：库空 vs 条件没命中", () => {
    expect(emptyStateKind(0, false)).toBe("empty-library");
    expect(emptyStateKind(0, true)).toBe("no-match");
    expect(emptyStateKind(120, true)).toBe("no-match");
  });
});
