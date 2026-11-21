/**
 * 样品图墙的筛选状态（纯逻辑，页面只负责渲染）。
 *
 * 三个 chip 行都是单选：再点一次选中项即取消。筛选与关键词全部走服务端参数
 * （WAN-187），端上不做全量过滤 —— 手机上拉全量再 filter 会卡，而且分页会错。
 */

export interface SampleFilters {
  category: string | null;
  composition: string | null;
  /** 克重档位原文（服务端 `weights`），保留给「按原文精确选」的老入口。 */
  weight: string | null;
  color: string | null;
  /** 克重区间（g/m²，闭区间）；null 表示该端不限制。 */
  weightGsmMin: number | null;
  weightGsmMax: number | null;
}

export const EMPTY_SAMPLE_FILTERS: SampleFilters = {
  category: null,
  composition: null,
  weight: null,
  color: null,
  weightGsmMin: null,
  weightGsmMax: null,
};

export interface SampleListQuery {
  query?: string | null;
  category?: string | null;
  composition?: string | null;
  weights?: string[] | null;
  colors?: string[] | null;
  weightGsmMin?: number | null;
  weightGsmMax?: number | null;
  status?: "ACTIVE" | "ALL";
  cursor?: string | null;
  limit?: number;
}

/** 单选切换：点同一个 chip 取消，点别的替换。 */
export function toggleFacet(current: string | null, value: string): string | null {
  return current === value ? null : value;
}

export function hasActiveFilters(query: string, filters: SampleFilters): boolean {
  return (
    query.trim().length > 0 ||
    Boolean(
      filters.category ||
      filters.composition ||
      filters.weight ||
      filters.color ||
      filters.weightGsmMin !== null ||
      filters.weightGsmMax !== null,
    )
  );
}

/** 页面状态 → API 参数；空值不传，避免服务端把空串当成筛选条件。 */
export function buildSampleListQuery(
  query: string,
  filters: SampleFilters,
  cursor: string | null,
  limit = 20,
): SampleListQuery {
  const trimmed = query.trim();
  return {
    query: trimmed || null,
    category: filters.category,
    composition: filters.composition,
    weights: filters.weight ? [filters.weight] : null,
    colors: filters.color ? [filters.color] : null,
    weightGsmMin: filters.weightGsmMin,
    weightGsmMax: filters.weightGsmMax,
    status: "ACTIVE",
    cursor,
    limit,
  };
}

export interface ActiveFilterChip {
  key: "category" | "composition" | "weight" | "color" | "weightGsm";
  label: string;
}

/** 区间文案：只填一端时说「≥ / ≤」，避免出现 `200–null`。 */
export function weightGsmRangeLabel(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `克重：${min}–${max} g/m²`;
  if (min !== null) return `克重：≥${min} g/m²`;
  return `克重：≤${max} g/m²`;
}

/** 已选条件条：标签用业务词，不把内部字段名露给用户。 */
export function activeFilterChips(filters: SampleFilters): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  if (filters.category) chips.push({ key: "category", label: `品类：${filters.category}` });
  if (filters.composition)
    chips.push({ key: "composition", label: `成分：${filters.composition}` });
  if (filters.weight) chips.push({ key: "weight", label: `克重：${filters.weight}` });
  if (filters.color) chips.push({ key: "color", label: `颜色：${filters.color}` });
  if (filters.weightGsmMin !== null || filters.weightGsmMax !== null) {
    chips.push({
      key: "weightGsm",
      label: weightGsmRangeLabel(filters.weightGsmMin, filters.weightGsmMax),
    });
  }
  return chips;
}

/** 卡片底部一行：编号 · 克重；都为空时才说「规格未填」。 */
export function sampleCardMeta(sample: { code: string; weight?: string | null }): string {
  const weight = sample.weight?.trim();
  return weight ? `${sample.code} · ${weight}` : `${sample.code} · 规格未填`;
}

/** 空态分两种：库是空的，还是当前条件没命中。 */
export function emptyStateKind(total: number, filtered: boolean): "empty-library" | "no-match" {
  if (filtered) return "no-match";
  return total === 0 ? "empty-library" : "no-match";
}
