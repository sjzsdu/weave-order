"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useResourceOverview } from "@weave-order/core";
import type { ResourceOverview as ResourceOverviewData } from "@weave-order/schema";
import { EmptyState, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { Can } from "@/can";
import { useMounted } from "@/use-mounted";
import { useFieldOptions } from "@/field-options-manager";

const COMPLETENESS_LABEL = {
  composition: "成分",
  weight: "克重",
  width: "门幅",
  primaryImage: "主图",
} as const;

const CHART_STYLES = [
  { stroke: "stroke-indigo-600", dot: "bg-indigo-600" },
  { stroke: "stroke-moss-600", dot: "bg-moss-600" },
  { stroke: "stroke-amber-600", dot: "bg-amber-600" },
  { stroke: "stroke-vermilion-600", dot: "bg-vermilion-600" },
  { stroke: "stroke-ink-500", dot: "bg-ink-500" },
  { stroke: "stroke-ink-400", dot: "bg-ink-400" },
] as const;

type LabelMap = Readonly<Record<string, string>>;
type CategoryRow = ResourceOverviewData["samples"]["categories"][number];

export interface CategoryDistributionRow {
  key: string;
  label: string;
  count: number;
  percentage: number;
}

function percent(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

export function formatPercent(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${Number(value.toFixed(1))}%`;
}

/** 前五类保持服务端排序，长尾合成“其他”，避免环形图被大量小分类切碎。 */
export function buildCategoryDistribution(
  categories: readonly CategoryRow[],
  total: number,
  labels: LabelMap = {},
): CategoryDistributionRow[] {
  const nonEmpty = categories.filter((row) => row.count > 0);
  const visible = nonEmpty.slice(0, 5).map((row) => ({
    key: `category:${row.code ?? "uncategorized"}`,
    label: row.code === null ? "未分类" : (labels[row.code] ?? row.code),
    count: row.count,
    percentage: percent(row.count, total),
  }));
  const remaining = nonEmpty.slice(5).reduce((sum, row) => sum + row.count, 0);
  if (remaining > 0) {
    visible.push({
      key: "category:other",
      label: "其他",
      count: remaining,
      percentage: percent(remaining, total),
    });
  }
  return visible;
}

export function ResourceOverview() {
  const mounted = useMounted();
  if (!mounted) return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  return <ResourceOverviewContent />;
}

function ResourceOverviewContent() {
  const api = useApi();
  const overview = useResourceOverview(api);
  const templates = useQuery({
    queryKey: ["print", "templates"],
    queryFn: () => api.printTemplates(),
    staleTime: 60_000,
  });
  const { options: categoryOptions } = useFieldOptions("sample.category");
  const { options: tierOptions } = useFieldOptions("customer.tier");

  if (overview.isLoading) return <Spinner label="正在汇总资源概览…" />;
  if (overview.isError || !overview.data) {
    return (
      <EmptyState
        title="资源概览暂时不可用"
        description={overview.error instanceof Error ? overview.error.message : "请稍后重试"}
      />
    );
  }

  return (
    <ResourceOverviewView
      data={overview.data}
      templateCount={templates.data?.templates.length ?? null}
      categoryLabels={Object.fromEntries(
        categoryOptions.map((option) => [option.code, option.label]),
      )}
      tierLabels={Object.fromEntries(tierOptions.map((option) => [option.code, option.label]))}
    />
  );
}

export function ResourceOverviewView({
  data,
  templateCount,
  categoryLabels = {},
  tierLabels = {},
}: {
  data: ResourceOverviewData;
  templateCount: number | null;
  categoryLabels?: LabelMap;
  tierLabels?: LabelMap;
}) {
  const categories = buildCategoryDistribution(
    data.samples.categories,
    data.samples.available,
    categoryLabels,
  );

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">资源</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">资源概览</h1>
          <p className="mt-1 text-sm text-ink-400">
            生成于 {new Date(data.generatedAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/panorama/customers?new=1"
            className="inline-flex min-h-9 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
          >
            建客户
          </Link>
          <Link
            href="/panorama/samples?new=1"
            className="inline-flex min-h-9 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
          >
            建样品
          </Link>
        </div>
      </header>

      <section aria-label="资源摘要" className="grid gap-3 md:grid-cols-3">
        <ResourceSummaryCard
          href="/panorama/customers"
          label="客户档案"
          value={`${data.customers.total} 个客户`}
          description="非草稿客户，与当前客户数据范围一致。"
        />
        <ResourceSummaryCard
          href="/panorama/samples"
          label="样品库"
          value={`${data.samples.available} 个可用样品`}
          description={`草稿 ${data.samples.draft} · 归档 ${data.samples.archived}`}
        />
        <ResourceSummaryCard
          href="/resources/templates"
          label="报价模板"
          value={templateCount === null ? "打印与样卡模板" : `${templateCount} 个模板`}
          description="系统模板随版本内置，公司可覆盖发布。"
        />
      </section>

      <section aria-label="业务快捷入口" className="grid gap-3 md:grid-cols-2">
        <Can cap="panorama.orders.view">
          <Link
            href="/panorama/orders"
            className="block rounded-lg border border-line bg-surface px-4 py-4 hover:border-indigo-600"
          >
            <div className="text-xs uppercase tracking-[0.18em] text-indigo-600">报价与订单</div>
            <div className="mt-1 text-base font-semibold text-ink-900">按交期看订单漏斗</div>
            <p className="mt-1 text-sm text-ink-400">
              逾期的排最前，点开就是那张单，从草稿到发货一路看得见。
            </p>
          </Link>
        </Can>
        <Link
          href="/panorama/receivables"
          className="block rounded-lg border border-line bg-surface px-4 py-4 hover:border-indigo-600"
        >
          <div className="text-xs uppercase tracking-[0.18em] text-indigo-600">应收与对账</div>
          <div className="mt-1 text-base font-semibold text-ink-900">逾期、本月到期、已结清</div>
          <p className="mt-1 text-sm text-ink-400">
            登记回款后余额与分组立即刷新；对账单能点开看到每笔订单与每笔回款。
          </p>
        </Link>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <CategoryChart categories={categories} total={data.samples.available} />
        <TierChart tiers={data.customers.tiers} total={data.customers.total} labels={tierLabels} />
      </div>

      <CompletenessPanel data={data.samples} />
    </div>
  );
}

function ResourceSummaryCard({
  href,
  label,
  value,
  description,
}: {
  href: string;
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-line bg-surface px-4 py-4 hover:border-indigo-600"
    >
      <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-indigo-600">
        <span>{label}</span>
        <span aria-hidden="true">→</span>
      </div>
      <div className="mt-1 text-base font-semibold text-ink-900">{value}</div>
      <p className="mt-1 text-sm text-ink-400">{description}</p>
    </Link>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      <p className="mt-1 text-sm text-ink-400">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function CategoryChart({
  categories,
  total,
}: {
  categories: CategoryDistributionRow[];
  total: number;
}) {
  const accessibleDescription = categories
    .map((row) => `${row.label} ${row.count} 个，占 ${formatPercent(row.percentage)}`)
    .join("；");

  return (
    <Panel title="样品品类分布" description="可用样品的品类构成，未填写品类的样品单独归集。">
      {total === 0 || categories.length === 0 ? (
        <EmptyState title="还没有可用样品" description="新建或启用样品后，这里会显示品类分布。" />
      ) : (
        <div className="flex flex-col items-center gap-6 sm:flex-row">
          <div className="relative h-40 w-40 shrink-0">
            <svg
              viewBox="0 0 144 144"
              className="h-full w-full -rotate-90"
              role="img"
              aria-labelledby="sample-category-chart-title"
              aria-describedby="sample-category-chart-description"
            >
              <title id="sample-category-chart-title">可用样品品类分布</title>
              <desc id="sample-category-chart-description">{accessibleDescription}</desc>
              <circle cx="72" cy="72" r="54" fill="none" strokeWidth="18" className="stroke-line" />
              {categories.map((row, index) => {
                const offset = categories
                  .slice(0, index)
                  .reduce((sum, previous) => sum + previous.percentage, 0);
                return (
                  <circle
                    key={row.key}
                    cx="72"
                    cy="72"
                    r="54"
                    fill="none"
                    pathLength="100"
                    strokeWidth="18"
                    strokeDasharray={`${row.percentage} ${100 - row.percentage}`}
                    strokeDashoffset={-offset}
                    className={CHART_STYLES[index % CHART_STYLES.length]!.stroke}
                  />
                );
              })}
            </svg>
            <div
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
              aria-hidden="true"
            >
              <span className="font-mono text-2xl font-bold tabular-nums text-ink-900">
                {total}
              </span>
              <span className="text-xs text-ink-400">可用样品</span>
            </div>
          </div>
          <ul
            className="grid w-full min-w-0 flex-1 gap-3 sm:grid-cols-2"
            aria-label="品类数量与占比"
          >
            {categories.map((row, index) => (
              <li key={row.key} className="min-w-0 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-ink-700">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-pill ${CHART_STYLES[index % CHART_STYLES.length]!.dot}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">{row.label}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-ink-500">
                    {row.count} · {formatPercent(row.percentage)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function TierChart({
  tiers,
  total,
  labels,
}: {
  tiers: ResourceOverviewData["customers"]["tiers"];
  total: number;
  labels: LabelMap;
}) {
  return (
    <Panel title="客户等级分布" description="当前数据范围内的非草稿客户，按公司配置的等级统计。">
      {total === 0 || tiers.length === 0 ? (
        <EmptyState title="还没有客户档案" description="新建客户后，这里会显示等级分布。" />
      ) : (
        <ul className="grid gap-4" aria-label="客户等级数量与占比">
          {tiers.map((tier) => {
            const percentage = percent(tier.count, total);
            return (
              <li key={tier.code}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-ink-700">{labels[tier.code] ?? tier.code}</span>
                  <span className="font-mono text-xs tabular-nums text-ink-500">
                    {tier.count} 个 · {formatPercent(percentage)}
                  </span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-pill bg-paper-deep"
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-pill bg-indigo-600"
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function CompletenessPanel({ data }: { data: ResourceOverviewData["samples"] }) {
  return (
    <Panel title="样品资料完整度" description="可用样品中，关键资料已经填写的数量与比例。">
      {data.available === 0 ? (
        <EmptyState
          title="暂无完整度数据"
          description="有可用样品后，再检查成分、克重、门幅和主图。"
        />
      ) : (
        <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
          {data.completeness.map((row) => {
            const percentage = percent(row.completeCount, data.available);
            return (
              <div key={row.key}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-ink-700">{COMPLETENESS_LABEL[row.key]}</span>
                  <span className="font-mono text-xs tabular-nums text-ink-500">
                    完整 {row.completeCount} / {data.available} · {formatPercent(percentage)}
                  </span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-pill bg-paper-deep"
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-pill bg-moss-600"
                    style={{ width: `${percentage}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-ink-400">缺少 {row.missingCount} 个</p>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
