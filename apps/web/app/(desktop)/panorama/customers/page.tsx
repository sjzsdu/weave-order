"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useCustomerList } from "@weave-order/core";
import type { CustomerListOptions } from "@weave-order/schema";
import { Badge, EmptyState, MoneyText, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { Customer360Panel } from "@/customer-360";
import { TIER_LABEL, relativeTime } from "@/format";

const PAGE_SIZE = 100;

export default function CustomersPage() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <CustomersPageContent />;
}

function CustomersPageContent() {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<"mine" | "all">("mine");
  const [tier, setTier] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 从时间线 / 别人发来的链接带 ?id= 进来直接展开抽屉；筛选也能分享。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) setSelectedId(id);
    const initialQuery = params.get("q");
    if (initialQuery) setQuery(initialQuery);
    const initialOwner = params.get("owner");
    if (initialOwner === "all" || initialOwner === "mine") setOwner(initialOwner);
    const initialTier = params.get("tier");
    if (initialTier) setTier(initialTier);
    if (params.get("overdue") === "1") setOverdueOnly(true);
  }, []);

  // 搜索走防抖，避免每敲一个字打一次后端。
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const filters = useMemo<CustomerListOptions>(
    () => ({
      limit: PAGE_SIZE,
      owner,
      ...(debouncedQuery ? { query: debouncedQuery } : {}),
      ...(tier ? { tier: tier as CustomerListOptions["tier"] } : {}),
      ...(overdueOnly ? { overdueOnly: true } : {}),
    }),
    [owner, debouncedQuery, tier, overdueOnly],
  );

  const customers = useCustomerList(api, filters);

  function closeDrawer() {
    setSelectedId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("id");
    window.history.replaceState(null, "", url.toString());
  }

  function openDrawer(id: string) {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("id", id);
    window.history.replaceState(null, "", url.toString());
  }

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/panorama" className="text-xs text-ink-400 underline underline-offset-2">
            ← 回业务全景
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">客户</h1>
          <p className="mt-1 text-sm text-ink-400">
            未决报价 / 在途寄样 / 应收余额都由后端聚合，点开就是客户 360。
          </p>
        </div>
        <Badge tone="neutral">只读视图</Badge>
      </header>

      <section className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <label className="flex min-h-9 flex-1 items-center gap-2 rounded-md border border-line bg-paper/40 px-3 md:max-w-sm">
          <span aria-hidden className="text-ink-400">
            ⌕
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜客户名 / 编号 / 联系人"
            className="min-h-9 w-full bg-transparent text-sm text-ink-900 outline-none"
            aria-label="搜索客户"
          />
        </label>

        <label className="flex items-center gap-2 text-sm text-ink-700">
          负责人
          <select
            value={owner}
            onChange={(event) => setOwner(event.target.value as "mine" | "all")}
            className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
          >
            <option value="mine">我的</option>
            <option value="all">全部</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-ink-700">
          状态
          <select
            value={tier}
            onChange={(event) => setTier(event.target.value)}
            className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
          >
            <option value="">全部等级</option>
            <option value="VIP">VIP</option>
            <option value="REGULAR">常规</option>
            <option value="NEW">新客</option>
            <option value="COLD">沉睡</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(event) => setOverdueOnly(event.target.checked)}
            className="h-4 w-4"
          />
          只看有逾期
        </label>

        <span className="ml-auto text-xs text-ink-400">
          {customers.data ? `${customers.data.length} 位客户` : "正在汇总…"}
        </span>
      </section>

      {customers.isLoading ? (
        <div className="rounded-lg border border-line bg-surface px-6 py-10">
          <Spinner label="正在汇总客户…" />
        </div>
      ) : customers.isError ? (
        <EmptyState
          title="客户列表暂时不可用"
          description={customers.error instanceof Error ? customers.error.message : "请稍后重试"}
        />
      ) : (customers.data ?? []).length === 0 ? (
        <EmptyState title="没有匹配的客户" description="换一个筛选条件，或让agent导入新的客户。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">客户</th>
                <th className="px-3 py-2 text-left font-normal">负责人</th>
                <th className="px-3 py-2 text-left font-normal">最近联系</th>
                <th className="px-3 py-2 text-right font-normal">未决报价</th>
                <th className="px-3 py-2 text-right font-normal">在途寄样</th>
                <th className="px-3 py-2 text-right font-normal">应收余额</th>
                <th className="px-3 py-2 text-left font-normal">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(customers.data ?? []).map((customer) => (
                <tr
                  key={customer.id}
                  className={cn(
                    "cursor-pointer hover:bg-paper",
                    selectedId === customer.id && "bg-indigo-100/30",
                  )}
                  onClick={() => openDrawer(customer.id)}
                >
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-left"
                      onClick={(event) => {
                        event.stopPropagation();
                        openDrawer(customer.id);
                      }}
                    >
                      <div className="font-medium text-ink-900">{customer.name}</div>
                      <div className="text-xs text-ink-400">
                        {customer.code}
                        {customer.contactName ? ` · ${customer.contactName}` : ""}
                      </div>
                    </button>
                  </td>
                  <td className="px-3 py-2 text-ink-700">{customer.ownerName ?? "未分配"}</td>
                  <td className="px-3 py-2 text-xs text-ink-400">
                    {customer.lastContactAt ? relativeTime(customer.lastContactAt) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-900">
                    {customer.pendingQuoteCount}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-900">
                    {customer.inTransitSampleCount}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {customer.receivableBalance.length === 0 ? (
                      <span className="text-ink-400">—</span>
                    ) : (
                      <span className="flex flex-col items-end gap-0.5">
                        {customer.receivableBalance.map((money) => (
                          <MoneyText key={money.currency} money={money} size="sm" />
                        ))}
                      </span>
                    )}
                    {customer.overdueReceivableCount > 0 && (
                      <span className="mt-0.5 block text-xs text-vermilion-600">
                        {customer.overdueReceivableCount} 笔逾期
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={customer.tier === "VIP" ? "info" : "neutral"}>
                      {TIER_LABEL[customer.tier] ?? customer.tier}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="客户 360"
          className="fixed inset-0 z-40 flex justify-end bg-ink-900/20"
          onClick={closeDrawer}
        >
          <div
            className="h-full w-full max-w-[760px] overflow-y-auto bg-paper shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <Customer360Panel customerId={selectedId} onClose={closeDrawer} />
          </div>
        </div>
      )}
    </div>
  );
}
