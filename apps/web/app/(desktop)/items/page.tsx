"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Badge, EmptyState, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { track } from "@/analytics";
import { ITEM_STATUS_LABEL, ITEM_STATUS_TONE, itemQuantityText } from "@/item-format";
import { UNIFIED_INPUT_PROMPT, unifiedInputHref } from "@/unified-input";
import { relativeTime } from "@/format";

const FILTERS = [
  { key: "recent", label: "最近事项", hint: "按最近更新排序" },
  { key: "mine", label: "待我处理", hint: "我创建且还没结束的事项" },
] as const;

type ItemFilter = (typeof FILTERS)[number]["key"];

function parseFilter(value: string | null): ItemFilter {
  return value === "mine" ? "mine" : "recent";
}

/**
 * 事项首页（WAN-196 / D4）：登录后的第一屏。
 *
 * 两个过滤走同一条 `GET /items`（`filter=recent|mine`，游标分页），
 * 列表项只回答一件事：这件事是谁的、做到哪了、下一步做什么。
 */
export default function ItemsPage() {
  const mounted = useMounted();
  if (!mounted) return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  return <ItemsPageContent />;
}

function ItemsPageContent() {
  const api = useApi();
  const params = useSearchParams();
  const filter = parseFilter(params.get("filter"));

  const items = useInfiniteQuery({
    queryKey: ["items", filter],
    queryFn: ({ pageParam }) =>
      api.listItems({ filter, limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo(() => items.data?.pages.flatMap((page) => page.items) ?? [], [items.data]);

  // 埋点只用枚举/短文案，不把客户名、样品名带出站（analytics.ts 有同等白名单）。
  useEffect(() => {
    track("items_viewed", { filter });
  }, [filter]);

  if (items.isLoading) return <Spinner label="正在读取事项…" />;
  if (items.isError) {
    return (
      <EmptyState
        title="事项暂时不可用"
        description={items.error instanceof Error ? items.error.message : "请稍后重试"}
        actions={
          <button
            type="button"
            onClick={() => void items.refetch()}
            className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
          >
            重试
          </button>
        }
      />
    );
  }

  return (
    <div className="grid gap-4 pb-24 md:pb-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">事项</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">最近在办的事</h1>
          <p className="mt-1 text-sm text-ink-400">
            AI 在跟的事都在这儿；卡住时看「下一步」，需要你就点进去。
          </p>
        </div>
        <Link
          href={unifiedInputHref(UNIFIED_INPUT_PROMPT)}
          className="inline-flex min-h-11 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
        >
          新建事项
        </Link>
      </header>

      <nav aria-label="事项筛选" className="flex gap-1 overflow-x-auto">
        {FILTERS.map((entry) => {
          const active = entry.key === filter;
          return (
            <Link
              key={entry.key}
              href={`/items?filter=${entry.key}`}
              aria-current={active ? "page" : undefined}
              title={entry.hint}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center rounded-md px-4 text-sm",
                active
                  ? "bg-indigo-100 font-medium text-indigo-600"
                  : "text-ink-700 hover:bg-surface",
              )}
            >
              {entry.label}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          title={filter === "mine" ? "没有待你处理的事项" : "还没有事项"}
          description={UNIFIED_INPUT_PROMPT}
          actions={
            <>
              <Link
                href={unifiedInputHref(UNIFIED_INPUT_PROMPT)}
                className="inline-flex min-h-11 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
              >
                用一句话或一张照片开始
              </Link>
              <Link
                href="/resources"
                className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
              >
                先看看资源
              </Link>
            </>
          }
        />
      ) : (
        <ul className="grid gap-2">
          {rows.map((detail) => {
            const { item, customer, sample } = detail;
            const terminal = item.status === "COMPLETED" || item.status === "CLOSED";
            return (
              <li key={item.id}>
                <Link
                  href={`/items/${item.id}`}
                  onClick={() => track("item_opened", { status: item.status, filter })}
                  className={cn(
                    "block rounded-lg border border-line bg-surface px-4 py-3 hover:border-indigo-600",
                    terminal && "opacity-80",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-base font-semibold text-ink-900">
                        {customer?.name ?? "客户待补充"} · {sample?.name ?? "样品待补充"}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-400">
                        {customer?.code ?? "无客户编号"} / {sample?.code ?? "无样品编号"}
                        <span className="mx-1">·</span>
                        {relativeTime(item.updatedAt)}
                      </div>
                    </div>
                    <Badge tone={ITEM_STATUS_TONE[item.status]}>
                      {ITEM_STATUS_LABEL[item.status]}
                    </Badge>
                  </div>
                  {/* 标签与值都左对齐：长中文文案右对齐后扫读会断行成两截。 */}
                  <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-3">
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-ink-400">数量</dt>
                      <dd className="text-ink-900">
                        {itemQuantityText(item.quantityMilli, item.unit)}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-ink-400">阶段</dt>
                      <dd className="text-ink-900">{item.currentStage ?? "—"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-ink-400">下一步</dt>
                      <dd className="text-ink-900">{item.nextAction ?? "—"}</dd>
                    </div>
                  </dl>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {items.hasNextPage ? (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={items.isFetchingNextPage}
            onClick={() => void items.fetchNextPage()}
            className="inline-flex min-h-11 items-center rounded-md border border-line bg-surface px-6 text-sm text-ink-700 hover:border-ink-400 disabled:opacity-60"
          >
            {items.isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : rows.length > 0 ? (
        <p className="text-center text-xs text-ink-400">没有更多了</p>
      ) : null}
    </div>
  );
}
