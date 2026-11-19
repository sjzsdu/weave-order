import { Image, Input, Text, View } from "@tarojs/components";
import { useDidShow } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FabricSample } from "@weave-order/schema";
import { Badge, Button, Card, EmptyState, Page, Sheet } from "../../components/ui";
import { api, IS_MOCK } from "../../lib/runtime";
import { userFacingErrorMessage } from "../../lib/upload-failure";
import { enterCamera, enterQuote } from "../../routes";
import {
  EMPTY_SAMPLE_FILTERS,
  activeFilterChips,
  buildSampleListQuery,
  emptyStateKind,
  hasActiveFilters,
  sampleCardMeta,
  toggleFacet,
} from "../../lib/sample-filters";
import type { SampleFilters } from "../../lib/sample-filters";

type PageData = Awaited<ReturnType<typeof api.listSamplesPage>>;

/**
 * 样品是一级 tab：搜索 + 品类/成分/克重单选 chips + 两列图墙。
 *
 * 筛选与关键词全部走服务端（WAN-187 的 `composition` / `weights`），端上不拉全量过滤。
 * 切筛选时保留旧列表，只置 `refreshing`，新结果到达再替换 —— 避免整页闪一下再回来。
 */
export default function SamplesPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [samples, setSamples] = useState<FabricSample[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filters, setFilters] = useState<SampleFilters>(EMPTY_SAMPLE_FILTERS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FabricSample | null>(null);
  // 只认最后一次请求：连续切 chip 时旧响应不能覆盖新结果。
  const requestSeq = useRef(0);
  const hasData = useRef(false);
  const mounted = useRef(false);

  const runQuery = useCallback(
    async (cursor: string | null, replace: boolean) => {
      const ticket = ++requestSeq.current;
      if (replace && hasData.current) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await api.listSamplesPage(
          buildSampleListQuery(debouncedQuery, filters, cursor),
        );
        if (ticket !== requestSeq.current) return;
        hasData.current = true;
        setData(page);
        setSamples((current) => (replace ? page.samples : [...current, ...page.samples]));
      } catch (caught) {
        if (ticket !== requestSeq.current) return;
        // 技术原文只进日志：Zod 的 invalid_type 之类不能直接展示给用户。
        console.error("[samples] 加载失败", caught);
        // 出错保留已加载数据，不清空列表。
        setError(userFacingErrorMessage(caught, "加载样品失败，请重试"));
      } finally {
        if (ticket === requestSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [debouncedQuery, filters],
  );

  // 搜索防抖 300ms；回车立即生效（setDebouncedQuery 直接写入）。
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // 关键词或任一 chip 变化都重新从第一页取（服务端筛选，端上不排序不过滤）。
  useEffect(() => {
    void runQuery(null, true);
  }, [runQuery]);

  useDidShow(() => {
    // 首次显示由上面的 effect 负责，避免同一次进入发两次请求；再回来时刷新一次。
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void runQuery(null, true);
  });

  const filtered = hasActiveFilters(debouncedQuery, filters);
  const activeChips = activeFilterChips(filters);
  const cameraEntry = () => enterCamera({ mode: "sample" });

  const clearFacet = (key: "category" | "composition" | "weight") =>
    setFilters((current) => ({ ...current, [key]: null }));

  const clearAll = () => {
    setQuery("");
    setDebouncedQuery("");
    setFilters(EMPTY_SAMPLE_FILTERS);
  };

  const wall = (
    <View className={`sample-wall${refreshing ? " sample-wall-refreshing" : ""}`}>
      {samples.map((sample) => {
        const primary =
          sample.images?.find((image) => image.isPrimary) ?? sample.images?.[0] ?? null;
        const thumb = primary?.thumbUrl ?? primary?.url ?? sample.primaryImageUrl;
        return (
          <View key={sample.id} className="sample-card" onClick={() => setSelected(sample)}>
            <View className="sample-thumb-wrap">
              {thumb ? (
                <Image className="sample-thumb" src={thumb} mode="aspectFill" />
              ) : (
                <View className="sample-thumb-empty">待补图</View>
              )}
            </View>
            <View className="sample-body">
              <View className="sample-name">{sample.name}</View>
              <View className="sample-foot">
                <Text className="sample-meta">{sampleCardMeta(sample)}</Text>
                <View
                  className="sample-quote"
                  ariaRole="button"
                  ariaLabel="用它报价"
                  onClick={(event) => {
                    // 点 pill 是报价，点卡片其它区域才是看详情，不能让冒泡把两者混在一起。
                    event.stopPropagation();
                    enterQuote({ mode: "sample", sampleId: sample.id });
                  }}
                >
                  用它报价
                </View>
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );

  return (
    <Page>
      <View className="samples-sticky">
        <View className="samples-search-row">
          <Input
            className="input samples-search"
            value={query}
            placeholder="搜品名 / 编号"
            confirmType="search"
            onInput={(event) => setQuery(event.detail.value)}
            onConfirm={() => setDebouncedQuery(query.trim())}
          />
          {samples.length > 0 && (
            <View
              className="samples-camera"
              ariaRole="button"
              ariaLabel="拍照建样品"
              onClick={cameraEntry}
            >
              <Text className="samples-camera-icon">＋</Text>
            </View>
          )}
        </View>

        {filtered && (
          <View className="samples-selected">
            <View className="chip-row">
              {activeChips.map((chip) => (
                <View
                  key={chip.key}
                  className="chip chip-active"
                  onClick={() => clearFacet(chip.key)}
                >
                  {chip.label} ×
                </View>
              ))}
              <View className="chip chip-count">共 {data?.total ?? 0} 个</View>
            </View>
            <View className="link samples-clear" onClick={clearAll}>
              清除
            </View>
          </View>
        )}
        {refreshing && <View className="samples-progress" />}
      </View>

      {IS_MOCK && (
        <Card className="card-flat">
          <View className="muted">演示模式只有示例样品，图片上传需切到真实后端。</View>
        </Card>
      )}

      <FacetRow
        label="品类"
        options={data?.categories ?? []}
        value={filters.category}
        onChange={(value) =>
          setFilters((current) => ({
            ...current,
            category: value === null ? null : toggleFacet(current.category, value),
          }))
        }
      />
      <FacetRow
        label="成分"
        options={data?.compositions ?? []}
        value={filters.composition}
        onChange={(value) =>
          setFilters((current) => ({
            ...current,
            composition: value === null ? null : toggleFacet(current.composition, value),
          }))
        }
      />
      <FacetRow
        label="克重"
        options={data?.weights ?? []}
        value={filters.weight}
        onChange={(value) =>
          setFilters((current) => ({
            ...current,
            weight: value === null ? null : toggleFacet(current.weight, value),
          }))
        }
      />

      {error && (
        <Card className="card-flat">
          <View className="warn-text">{error}</View>
        </Card>
      )}

      {loading && samples.length === 0 && <View className="muted samples-loading">加载中…</View>}

      {!loading && samples.length === 0 && !error && (
        <EmptyState
          title={
            emptyStateKind(data?.total ?? 0, filtered) === "empty-library"
              ? "还没有样品"
              : "这个条件下没有样品"
          }
          desc={
            emptyStateKind(data?.total ?? 0, filtered) === "empty-library"
              ? "拍一张布建第一个样品，规格之后可以补。"
              : "换个成分或克重试试，也可以清除筛选看全部。"
          }
          action={
            emptyStateKind(data?.total ?? 0, filtered) === "empty-library" ? (
              <Button onClick={cameraEntry}>拍照建样品</Button>
            ) : (
              <Button variant="ghost" onClick={clearAll}>
                清除筛选
              </Button>
            )
          }
        />
      )}

      {samples.length > 0 && wall}

      {data && data.remaining > 0 && (
        <View className="actions" style={{ marginTop: 12 }}>
          <Button
            block
            variant="ghost"
            loading={loading}
            onClick={() => void runQuery(data.nextCursor, false)}
          >
            还有 {data.remaining} 个，加载更多
          </Button>
        </View>
      )}

      <Sheet open={selected !== null} title="样品详情" onClose={() => setSelected(null)}>
        {selected && (
          <View>
            {(selected.images?.[0]?.url ?? selected.primaryImageUrl) ? (
              <Image
                src={selected.images?.[0]?.url ?? selected.primaryImageUrl ?? ""}
                mode="widthFix"
                className="sample-detail-image"
              />
            ) : (
              <View className="sample-detail-image sample-thumb-empty">待补图</View>
            )}
            <View className="label">编码</View>
            <Text>{selected.code}</Text>
            <View className="label">成分 / 克重</View>
            <Text>
              {[selected.composition ?? "成分未填", selected.weight ?? "克重未填"].join(" · ")}
            </Text>
            <View className="label">状态</View>
            <Badge tone={selected.status === "ACTIVE" ? "accent" : "warn"}>
              {selected.status === "ACTIVE" ? "在售" : "已归档"}
            </Badge>
            <View className="footnote">移动端只做看图与建样品；改规格、排序图片请到 PC 图墙。</View>
            <View className="actions">
              <Button
                block
                variant="ghost"
                onClick={() => {
                  const sampleId = selected.id;
                  setSelected(null);
                  // 带上 sampleId：报价页据此预填面料，否则样品库入口等于断链（WAN-160 A）。
                  enterQuote({ mode: "sample", sampleId });
                }}
              >
                用这个样品报价
              </Button>
            </View>
          </View>
        )}
      </Sheet>
    </Page>
  );
}

/** 一行横向滚动的单选 chips；没有选项时整行不出现（空库不摆一排「全部」）。 */
function FacetRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string | null;
  /** null 表示「全部」：显式清空，不走 toggle（否则会存一个空串）。 */
  onChange: (value: string | null) => void;
}) {
  if (options.length === 0) return null;
  return (
    <View className="facet-row">
      <Text className="facet-label">{label}</Text>
      <View className="facet-scroll">
        <View
          className={`chip${value === null ? " chip-active" : ""}`}
          onClick={() => onChange(null)}
        >
          全部
        </View>
        {options.map((option) => (
          <View
            key={option}
            className={`chip${value === option ? " chip-active" : ""}`}
            onClick={() => onChange(option)}
          >
            {option}
          </View>
        ))}
      </View>
    </View>
  );
}
