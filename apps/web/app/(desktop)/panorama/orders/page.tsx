"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { OrderStatus } from "@weave-order/schema";
import { useCustomers, useOrderFunnel, useOrderList } from "@weave-order/core";
import { Badge, Button, EmptyState, MoneyText, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { ORDER_STATUS_LABEL, actionLabel, relativeTime } from "@/format";

type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

const STATUS_TONE: Record<OrderStatus, StatusTone> = {
  DRAFT: "warning",
  CONFIRMED: "info",
  IN_PRODUCTION: "info",
  SHIPPED: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
};

function toStartOfDay(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T00:00:00`).toISOString();
}

function toEndOfDay(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T23:59:59.999`).toISOString();
}

/**
 * 订单列表：全景 → 报价与订单。
 *
 * 漏斗与列表共用同一套筛选（除状态外），点数字进去正好是那一批订单；
 * 逾期只看交期已过且未完成/未取消的单，数据范围由服务端 data-scope 过滤。
 */
export default function OrdersPage() {
  const mounted = useMounted();
  if (!mounted) return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  return <OrdersPageContent />;
}

function OrdersPageContent() {
  const api = useApi();
  const [statuses, setStatuses] = useState<OrderStatus[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueBefore, setDueBefore] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const dateFilters = useMemo(
    () => ({
      customerId: customerId || undefined,
      dueFrom: toStartOfDay(dueFrom),
      dueBefore: toEndOfDay(dueBefore),
      overdueOnly,
    }),
    [customerId, dueFrom, dueBefore, overdueOnly],
  );

  const filters = useMemo(
    () => ({ ...dateFilters, statuses: statuses.length > 0 ? statuses : undefined }),
    [dateFilters, statuses],
  );

  const list = useOrderList(api, filters);
  const funnel = useOrderFunnel(api, dateFilters);
  const customers = useCustomers(api, 100);

  const hasFilter =
    statuses.length > 0 || Boolean(customerId) || Boolean(dueFrom) || Boolean(dueBefore) || overdueOnly;

  function resetFilters() {
    setStatuses([]);
    setCustomerId("");
    setDueFrom("");
    setDueBefore("");
    setOverdueOnly(false);
  }

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/panorama" className="no-print text-xs text-ink-400 underline underline-offset-2">
            ← 回全景
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">报价与订单</h1>
          <p className="mt-1 text-sm text-ink-400">
            按交期升序，最急的在前 · 共 {list.total} 张订单
            {list.total > list.items.length ? ` · 已加载 ${list.items.length}` : ""}
          </p>
        </div>
        <Link
          href="/panorama/receivables"
          className="no-print inline-flex min-h-9 items-center rounded-md border border-line bg-surface px-3 text-sm text-ink-700 hover:border-ink-400"
        >
          去应收与对账 →
        </Link>
      </header>

      <section className="no-print grid grid-cols-2 gap-2 md:grid-cols-4">
        {(funnel.data?.stages ?? []).map((stage) => {
          const active =
            statuses.length === stage.statuses.length &&
            stage.statuses.every((status) => statuses.includes(status));
          return (
            <button
              key={stage.key}
              type="button"
              onClick={() => setStatuses(active ? [] : [...stage.statuses])}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-surface px-4 py-3 text-left transition-colors",
                active ? "border-indigo-600 ring-1 ring-indigo-600/30" : "border-line hover:border-ink-400",
              )}
            >
              <div className="text-xs text-ink-400">{stage.label}</div>
              <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-ink-900">
                {stage.count}
              </div>
            </button>
          );
        })}
      </section>

      <section className="no-print flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <label className="grid gap-1 text-xs text-ink-400">
          状态
          <select
            value={statuses.length === 1 ? statuses[0] : ""}
            onChange={(event) => {
              const value = event.target.value as OrderStatus | "";
              setStatuses(value ? [value] : []);
            }}
            className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          >
            <option value="">全部</option>
            {(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((status) => (
              <option key={status} value={status}>
                {ORDER_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs text-ink-400">
          客户
          <select
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
            className="min-h-9 min-w-[160px] rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          >
            <option value="">全部客户</option>
            {(customers.data ?? []).map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs text-ink-400">
          交期从
          <input
            type="date"
            value={dueFrom}
            onChange={(event) => setDueFrom(event.target.value)}
            className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          />
        </label>

        <label className="grid gap-1 text-xs text-ink-400">
          交期到
          <input
            type="date"
            value={dueBefore}
            onChange={(event) => setDueBefore(event.target.value)}
            className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          />
        </label>

        <label className="inline-flex min-h-9 items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(event) => setOverdueOnly(event.target.checked)}
          />
          只看逾期
        </label>

        {hasFilter && (
          <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={resetFilters}>
            清除筛选
          </Button>
        )}
      </section>

      {list.isLoading ? (
        <Spinner label="正在读取订单…" />
      ) : list.isError ? (
        <EmptyState
          title="订单暂时读不出来"
          description={list.error instanceof Error ? list.error.message : "请稍后重试"}
        />
      ) : list.items.length === 0 ? (
        <EmptyState
          title="没有符合条件的订单"
          description={hasFilter ? "放宽筛选再试，或清除筛选看全部。" : "报价成交后会自动出现在这里。"}
          actions={
            hasFilter ? (
              <Button variant="secondary" onClick={resetFilters}>
                清除筛选
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">客户</th>
                <th className="px-3 py-2 text-left font-normal">合同号</th>
                <th className="px-3 py-2 text-right font-normal">总额</th>
                <th className="px-3 py-2 text-left font-normal">交期</th>
                <th className="px-3 py-2 text-left font-normal">状态</th>
                <th className="px-3 py-2 text-left font-normal">已发未发</th>
                <th className="px-3 py-2 text-left font-normal">最近动作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.items.map((order) => (
                <tr key={order.id} className={cn(order.overdue && "bg-vermilion-100/40")}>
                  <td className="px-3 py-2">
                    <Link
                      href={`/panorama/orders/${order.id}`}
                      className="text-ink-900 hover:text-indigo-600 hover:underline"
                    >
                      {order.customerName}
                    </Link>
                    <div className="text-xs text-ink-400">{order.customerCode}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-ink-700">{order.code}</td>
                  <td className="px-3 py-2 text-right">
                    <MoneyText money={order.total} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-ink-700">
                      {order.dueDate ? new Date(order.dueDate).toLocaleDateString("zh-CN") : "未定"}
                    </div>
                    {order.overdue && <Badge tone="danger">逾期</Badge>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[order.status]}>{ORDER_STATUS_LABEL[order.status]}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-700">
                    <span className="font-mono tabular-nums">
                      {order.shippedLineCount}/{order.itemCount}
                    </span>{" "}
                    行已发
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-400">
                    {order.lastAction ? (
                      <>
                        <div className="text-ink-700">{actionLabel(order.lastAction.action)}</div>
                        <div>{relativeTime(order.lastAction.at)}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.hasNextPage && (
        <div className="no-print flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "正在加载…" : "加载更多"}
          </Button>
        </div>
      )}
    </div>
  );
}
