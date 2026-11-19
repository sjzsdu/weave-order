"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthContext } from "@weave-order/core";
import type { QuoteListItem, QuoteStatus } from "@weave-order/schema";
import { Badge, Button, EmptyState, Spinner, cn, formatMoney } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { STATUS_LABEL, relativeTime } from "@/format";
import { BUILTIN_TEMPLATES, QuoteComposer } from "@/quote-composer";
import type { ComposerTemplate } from "@/quote-composer";

const STATUS_TABS: Array<{ value: QuoteStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "全部" },
  { value: "DRAFT", label: "草稿" },
  { value: "SENT", label: "已发出" },
  { value: "ACCEPTED", label: "客户接受" },
  { value: "REJECTED", label: "已驳回" },
  { value: "EXPIRED", label: "已过期" },
];

const STATUS_TONE: Record<QuoteStatus, "neutral" | "success" | "warning" | "danger"> = {
  DRAFT: "warning",
  SENT: "neutral",
  ACCEPTED: "success",
  REJECTED: "danger",
  EXPIRED: "neutral",
};

export default function QuotesPage() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <QuotesPageContent />;
}

function QuotesPageContent() {
  const api = useApi();
  const queryClient = useQueryClient();
  const me = useAuthContext(api);
  const [status, setStatus] = useState<QuoteStatus | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [composer, setComposer] = useState<{
    quoteId: string | null;
    template: ComposerTemplate | null;
  } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo(
    () => ({
      status: status === "ALL" ? undefined : status,
      ...(debounced ? { query: debounced } : {}),
      limit: 50,
    }),
    [status, debounced],
  );

  const quotes = useQuery({
    queryKey: ["quotes", "workbench", filters],
    queryFn: () => api.quotes(filters),
  });

  if (me.isLoading) return <Spinner label="读取报价…" />;
  const canView =
    me.data !== undefined &&
    !("tenants" in me.data) &&
    me.data.capabilities.includes("quote.workbench.view");
  if (!canView) {
    return (
      <EmptyState
        title="当前角色没有报价工作台"
        description="报价工作台对销售、老板、主管与只读席位开放；需要时让管理员调整你的角色。"
        actions={
          <Link href="/panorama" className="text-sm text-indigo-600 underline underline-offset-2">
            回到业务
          </Link>
        }
      />
    );
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["quotes"] });
    void queryClient.invalidateQueries({ queryKey: ["panorama"] });
    void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  };

  const items = quotes.data?.items ?? [];
  const isEmpty = items.length === 0;
  const narrowed = status !== "ALL" || debounced !== "";

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">报价</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">报价工作台</h1>
          <p className="mt-1 text-sm text-ink-400">
            草稿、已发与客户回复都在这张表；点开一条即可改价、分享或去审批。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Button variant="secondary" onClick={() => setTemplatesOpen((open) => !open)}>
              报价模板
            </Button>
            {templatesOpen ? (
              <div
                role="menu"
                aria-label="报价模板"
                className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-line bg-surface p-1 shadow-card"
              >
                {BUILTIN_TEMPLATES.map((template) => (
                  <button
                    key={template.key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setTemplatesOpen(false);
                      setComposer({ quoteId: null, template });
                    }}
                    className="block w-full rounded-md px-3 py-2 text-left text-sm text-ink-700 hover:bg-paper"
                  >
                    {template.label}
                  </button>
                ))}
                <p className="mt-1 border-t border-line px-3 py-2 text-[11px] text-ink-400">
                  自定义模板编辑在后续版本开放；这里先用内置模板起步。
                </p>
              </div>
            ) : null}
          </div>
          <Button
            variant="primary"
            onClick={() => setComposer({ quoteId: null, template: null })}
          >
            新建报价
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="报价状态">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={status === tab.value}
              onClick={() => setStatus(tab.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs",
                status === tab.value
                  ? "bg-indigo-100 font-medium text-indigo-600"
                  : "text-ink-500 hover:bg-surface",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜客户名或面料描述"
          className="ml-auto min-w-52 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink-900 focus:border-indigo-600 focus:outline-none"
        />
      </div>

      {quotes.isLoading ? <Spinner label="正在整理报价…" /> : null}
      {quotes.isError ? (
        <EmptyState
          title="报价列表暂时读不到"
          description={quotes.error instanceof Error ? quotes.error.message : "请稍后重试"}
        />
      ) : null}

      {!quotes.isLoading && !quotes.isError && isEmpty ? (
        <EmptyState
          title={narrowed ? "没有符合条件的报价" : "还没有报价"}
          description={
            narrowed
              ? "换个状态或关键词试试；也可以直接新建一单。"
              : "从客户需求或一块面料开始，报价助手会给出合规建议价。"
          }
          actions={
            <Button variant="primary" onClick={() => setComposer({ quoteId: null, template: null })}>
              新建报价
            </Button>
          }
        />
      ) : null}

      {!quotes.isLoading && !isEmpty ? (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-4 py-2 text-left font-normal">客户</th>
                <th className="px-4 py-2 text-left font-normal">状态</th>
                <th className="px-4 py-2 text-right font-normal">金额</th>
                <th className="px-4 py-2 text-right font-normal">行数</th>
                <th className="px-4 py-2 text-left font-normal">最近更新</th>
                <th className="px-4 py-2 text-right font-normal">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((item) => (
                <QuoteRow
                  key={item.id}
                  item={item}
                  onOpen={() => setComposer({ quoteId: item.id, template: null })}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {composer ? (
        <QuoteComposer
          initialQuoteId={composer.quoteId}
          initialTemplate={composer.template}
          onClose={() => setComposer(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

function QuoteRow({ item, onOpen }: { item: QuoteListItem; onOpen: () => void }) {
  return (
    <tr className="hover:bg-paper/60">
      <td className="px-4 py-3">
        <button type="button" onClick={onOpen} className="text-left">
          <span className="font-medium text-ink-900">{item.customerName}</span>
          <span className="mt-0.5 block font-mono text-[11px] text-ink-400">
            {item.id.slice(0, 8)} · v{item.version}
          </span>
        </button>
      </td>
      <td className="px-4 py-3">
        <Badge tone={STATUS_TONE[item.status] ?? "neutral"}>
          {STATUS_LABEL[item.status] ?? item.status}
        </Badge>
      </td>
      <td className="px-4 py-3 text-right text-sm text-ink-900">{formatMoney(item.total)}</td>
      <td className="px-4 py-3 text-right text-xs text-ink-500">{item.itemCount}</td>
      <td className="px-4 py-3 text-xs text-ink-500">{relativeTime(item.updatedAt)}</td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={onOpen}
          className="text-xs text-indigo-600 underline underline-offset-2"
        >
          {item.status === "DRAFT" ? "继续编辑" : "查看"}
        </button>
      </td>
    </tr>
  );
}
