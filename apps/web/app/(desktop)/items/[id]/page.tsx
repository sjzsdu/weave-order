"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemStatus } from "@weave-order/schema";
import { Badge, Button, Card, EmptyState, Spinner, UndoToast, formatMoney } from "@weave-order/ui";
import { useTenantContext } from "@weave-order/core";
import { useApi } from "@/providers";
import { floorSourceLabel } from "@/floor-source-label";
import { confirmedByLabel } from "@/format";
import { ITEM_STATUS_LABEL, ITEM_STATUS_TONE, itemQuantityText } from "@/item-format";

const QUOTE_STATUS_TEXT: Record<string, string> = {
  DRAFT: "待确认价格",
  SENT: "已确认价格",
  ACCEPTED: "客户已接受",
  REJECTED: "已驳回",
  EXPIRED: "已过期",
};

const TRANSITION_LABEL: Partial<Record<ItemStatus, string>> = {
  WAITING_INPUT: "等我补资料",
  WAITING_DECISION: "等我决定",
  IN_PROGRESS: "回到处理中",
};

/**
 * 事项详情（P0a）：状态、客户、样品、数量、当前阶段、下一步动作。
 *
 * 两个交互纪律（WAN-196 设计评审）：
 * 1. 主行动只有一个 —— 「标记完成」是这件事的终点；其余状态迁移降为次级。
 * 2. 「关闭事项」是破坏性动作，收进「更多操作」并二次确认，不与主行动并列。
 */
export default function ItemDetailPage() {
  const params = useParams<{ id: string }>();
  const itemId = params?.id;
  const api = useApi();
  const tenantContext = useTenantContext(api);
  const mySubject = tenantContext.status === "READY" ? tenantContext.membership.subject : null;
  const router = useRouter();
  const queryClient = useQueryClient();
  const key = ["item", itemId] as const;

  const itemQuery = useQuery({
    queryKey: key,
    queryFn: () => api.getItem(itemId),
    enabled: Boolean(itemId),
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [quotePrice, setQuotePrice] = useState("");
  const [copied, setCopied] = useState(false);
  const [undoNotice, setUndoNotice] = useState<{ token: string; message: string } | null>(null);
  const dismissUndo = useCallback(() => setUndoNotice(null), []);

  const quotesQuery = useQuery({
    queryKey: ["item", itemId, "quotes"],
    queryFn: () => api.listItemQuotes(itemId),
    enabled: Boolean(itemId),
  });
  const confirmedQuote = quotesQuery.data?.quotes.find(
    (quote) => quote.status === "SENT" || quote.status === "ACCEPTED",
  );
  const copyQuery = useQuery({
    queryKey: ["quote", confirmedQuote?.id, "copy-text"],
    queryFn: () => api.quoteCopyText(confirmedQuote!.id),
    enabled: Boolean(confirmedQuote),
  });

  const basisQuery = useQuery({
    queryKey: ["quote", confirmedQuote?.id, "basis"],
    queryFn: () => api.quoteBasis(confirmedQuote!.id),
    enabled: Boolean(confirmedQuote),
    retry: false,
  });
  const undo = useMutation({
    mutationFn: (token: string) => api.undoItemTransition(itemId, { undoToken: token }),
    onSuccess: () => {
      setUndoNotice(null);
      setFeedback("已撤销状态变更");
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
    },
    onError: (error) => {
      setUndoNotice(null);
      setFeedback(error instanceof Error ? error.message : "撤销失败，请刷新后查看");
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
    },
  });

  const transition = useMutation({
    onMutate: () => setUndoNotice(null),
    mutationFn: (status: ItemStatus) => api.transitionItem(itemId, { status }),
    onSuccess: (detail) => {
      queryClient.setQueryData(key, detail);
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      setUndoNotice(
        detail.undoToken
          ? {
              token: detail.undoToken,
              message: "事项状态已更新",
            }
          : null,
      );
      // 撤销条已经承载这条消息，再写一行内联提示就是同一句话说两遍。
      setFeedback(detail.undoToken ? null : "事项状态已更新");
      setMoreOpen(false);
      setConfirmClose(false);
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "状态更新失败"),
  });
  const complete = useMutation({
    onMutate: () => setUndoNotice(null),
    mutationFn: () => api.completeItem(itemId),
    onSuccess: (detail) => {
      queryClient.setQueryData(key, detail);
      setUndoNotice(null);
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      setFeedback("事项已完成");
    },
    onError: (error) =>
      setFeedback(error instanceof Error ? error.message : "完成失败：还缺可观察的业务结果"),
  });
  const createQuote = useMutation({
    mutationFn: () => {
      const cents = quotePrice.trim() ? Math.round(Number(quotePrice) * 100) : undefined;
      if (cents !== undefined && (!Number.isFinite(cents) || cents <= 0)) {
        throw new Error("单价必须大于 0");
      }
      return api.createItemQuote(
        itemId,
        cents ? { unitPrice: { amount: cents, currency: "CNY" } } : {},
      );
    },
    onSuccess: (quote) => {
      void queryClient.invalidateQueries({ queryKey: ["item", itemId, "quotes"] });
      router.push(`/items/${itemId}/quotes/${quote.draft.id}`);
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "报价生成失败"),
  });

  const copyResult = async () => {
    if (!copyQuery.data) return;
    try {
      await navigator.clipboard.writeText(copyQuery.data.text);
      setCopied(true);
    } catch {
      setFeedback("浏览器拒绝了剪贴板权限，请手动全选复制");
    }
  };

  if (itemQuery.isLoading) return <Spinner label="正在读取事项…" />;
  if (itemQuery.isError || !itemQuery.data) {
    return (
      <EmptyState
        title="找不到这个事项"
        description={
          itemQuery.error instanceof Error ? itemQuery.error.message : "请从事项列表重新进入"
        }
      />
    );
  }

  const { item, customer, sample, allowedTransitions } = itemQuery.data;
  const terminal = item.status === "COMPLETED" || item.status === "CLOSED";
  const statusTransitions = allowedTransitions.filter(
    (status) => status !== "COMPLETED" && status !== "CLOSED",
  );
  const canClose = allowedTransitions.includes("CLOSED");
  const busy = transition.isPending || complete.isPending || undo.isPending;
  const quotes = quotesQuery.data?.quotes ?? [];

  return (
    <div className="grid gap-4 pb-24 md:pb-6">
      {undoNotice ? (
        <UndoToast
          key={undoNotice.token}
          message={undoNotice.message}
          pending={undo.isPending}
          onUndo={() => undo.mutate(undoNotice.token)}
          onDismiss={dismissUndo}
        />
      ) : null}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav
            aria-label="面包屑"
            className="flex flex-wrap items-center gap-1 text-xs text-ink-400"
          >
            <Link href="/items" className="hover:text-ink-900">
              事项
            </Link>
            <span>/</span>
            <span aria-current="page" className="text-ink-700">
              事项详情
            </span>
          </nav>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">
            {customer?.name ?? "未关联客户"} · {sample?.name ?? "未关联样品"}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            {customer ? `${customer.code} · ${customer.name}` : "客户待补充"}
            {" ｜ "}
            {sample ? `${sample.code} · ${sample.name}` : "样品待补充"}
          </p>
        </div>
        <Badge tone={ITEM_STATUS_TONE[item.status]}>{ITEM_STATUS_LABEL[item.status]}</Badge>
      </header>
      {item.nextAction ? (
        <Card className="border-l-4 border-l-indigo-600 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-indigo-600">下一步</div>
          <p className="mt-1 text-base font-medium text-ink-900">{item.nextAction}</p>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-medium text-ink-700">事项</h2>
          {/* 标签与值都左对齐：长中文右对齐后会断成两截，扫读反而更慢。 */}
          <dl className="mt-3 grid gap-2 text-sm">
            <div className="grid grid-cols-[4.5rem_1fr] gap-2">
              <dt className="text-ink-400">数量</dt>
              <dd className="min-w-0 text-ink-900">
                {itemQuantityText(item.quantityMilli, item.unit)}
              </dd>
            </div>
            <div className="grid grid-cols-[4.5rem_1fr] gap-2">
              <dt className="text-ink-400">当前阶段</dt>
              <dd className="min-w-0 text-ink-900">{item.currentStage ?? "—"}</dd>
            </div>
            <div className="grid grid-cols-[4.5rem_1fr] gap-2">
              <dt className="text-ink-400">下一步</dt>
              <dd className="min-w-0 text-ink-900">{item.nextAction ?? "—"}</dd>
            </div>
          </dl>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-medium text-ink-700">资源</h2>
          <div className="mt-3 grid gap-2 text-sm">
            <div className="grid grid-cols-[4.5rem_1fr] gap-2">
              <span className="text-ink-400">客户</span>
              {customer ? (
                <Link
                  href={`/panorama/customers/${customer.id}`}
                  className="min-h-11 min-w-0 text-ink-900 underline underline-offset-2"
                >
                  {customer.name}
                </Link>
              ) : (
                <span className="text-ink-400">待补充</span>
              )}
            </div>
            <div className="grid grid-cols-[4.5rem_1fr] gap-2">
              <span className="text-ink-400">样品</span>
              {sample ? (
                <Link
                  href={`/panorama/samples/${sample.id}/review`}
                  className="min-h-11 min-w-0 text-ink-900 underline underline-offset-2"
                >
                  {sample.name}
                </Link>
              ) : (
                <span className="text-ink-400">待补充</span>
              )}
            </div>
            {customer?.status === "DRAFT" || sample?.status === "DRAFT" ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                还有资源是草稿态：先确认可用，再继续报价。
              </p>
            ) : null}
          </div>
        </Card>
      </div>

      {/* 旅程 A：报价是这件事的主线，不另开审批入口。 */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-ink-700">报价</h2>
          {quotes.length > 0 ? (
            <span className="text-xs text-ink-400">同一事项可以有多个版本，确认其中一份即定稿</span>
          ) : null}
        </div>
        {quotes.length > 0 ? (
          <ul className="mt-3 grid gap-2">
            {quotes.map((quote) => (
              <li key={quote.id}>
                <Link
                  href={`/items/${itemId}/quotes/${quote.id}`}
                  className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-paper"
                >
                  <span className="font-medium text-ink-900">{quote.quoteNumber}</span>
                  <span className="text-ink-700">{formatMoney(quote.total)}</span>
                  <span className="text-ink-400">
                    {QUOTE_STATUS_TEXT[quote.status] ?? quote.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {!terminal && quotes.length === 0 ? (
          <div className="mt-3 grid gap-2 sm:flex sm:items-end">
            <label className="grid flex-1 gap-1 text-sm">
              <span className="text-ink-400">单价（元，留空由系统按成本底线给建议价）</span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={quotePrice}
                onChange={(event) => setQuotePrice(event.target.value)}
                className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
                aria-label="报价单价（元）"
              />
            </label>
            <Button
              variant="secondary"
              className="min-h-11"
              disabled={createQuote.isPending}
              onClick={() => createQuote.mutate()}
            >
              {createQuote.isPending ? "正在生成…" : "发起报价"}
            </Button>
          </div>
        ) : null}
        {!terminal && quotes.length > 0 && !confirmedQuote ? (
          <p className="mt-3 text-xs text-ink-400">
            还有未确认的报价版本，打开其中一份完成确认即可定稿。
          </p>
        ) : null}
      </Card>

      {item.status === "COMPLETED" && confirmedQuote ? (
        <Card className="border-l-4 border-l-emerald-600 p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-emerald-700">事项已完成</p>
          <h2 className="mt-1 text-lg font-semibold text-ink-900">
            {confirmedQuote.quoteNumber} · {formatMoney(confirmedQuote.total)}
          </h2>
          <p className="mt-1 text-sm text-ink-400">
            确认人{" "}
            {confirmedByLabel(
              confirmedQuote.confirmedByName,
              confirmedQuote.confirmedBy,
              mySubject,
            )}
            {confirmedQuote.confirmedAt
              ? ` · ${new Date(confirmedQuote.confirmedAt).toLocaleString("zh-CN")}`
              : ""}
            ｜ 价格已定稿，可随时复制给客户
          </p>
          {copyQuery.data ? (
            <>
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-paper p-3 text-sm text-ink-900">
                {copyQuery.data.text}
              </pre>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="primary" className="min-h-11" onClick={() => void copyResult()}>
                  {copied ? "已复制" : "复制报价文本"}
                </Button>
                <Link
                  href={`/items/${itemId}/quotes/${confirmedQuote.id}`}
                  className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-sm text-ink-900 hover:bg-paper"
                >
                  查看报价与依据
                </Link>
              </div>
            </>
          ) : (
            <p className="mt-2 text-xs text-ink-400">正在整理报价文本…</p>
          )}
        </Card>
      ) : null}

      {confirmedQuote && basisQuery.data && !basisQuery.isError ? (
        <Card className="min-w-0 p-4">
          <h2 className="text-sm font-medium text-ink-700">已确认报价的定价依据</h2>
          {basisQuery.data.lastDealUnitPrice && basisQuery.data.lastDealAt ? (
            <p className="mt-2 text-xs text-ink-500">
              历史成交参考：{formatMoney(basisQuery.data.lastDealUnitPrice)} ·{" "}
              {new Date(basisQuery.data.lastDealAt).toLocaleString("zh-CN")}
            </p>
          ) : null}
          {/* 窄屏不用横滚表格：底价和毛利被挤到屏幕外，等于又看不见依据了。 */}
          <ul className="mt-3 grid gap-3 md:hidden">
            {basisQuery.data.lines.map((line) => (
              <li key={line.lineIndex} className="rounded-md border border-line/70 p-3 text-sm">
                <p className="break-words font-medium text-ink-900">
                  {line.sampleCode} · {line.sampleName}
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {[
                    ["单价", formatMoney(line.unitPrice)],
                    ["样品成本底线", formatMoney(line.sampleCostFloor)],
                    ["含最低毛利的底价", formatMoney(line.priceFloor)],
                    ["毛利空间", `${(line.marginBps / 100).toFixed(1)}%`],
                    ["底价来源", floorSourceLabel(line.floorSource)],
                  ].map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-ink-400">{label}</dt>
                      <dd className="break-words text-ink-700">{value}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          <div className="mt-3 hidden md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-ink-400">
                  {["样品", "单价", "样品成本底线", "含最低毛利的底价", "毛利空间", "底价来源"].map(
                    (label) => (
                      <th key={label} className="py-2 pr-3 font-normal">
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {basisQuery.data.lines.map((line) => (
                  <tr key={line.lineIndex} className="border-b border-line/60 text-ink-700">
                    <td className="max-w-64 break-words py-2 pr-3">
                      {line.sampleCode} · {line.sampleName}
                    </td>
                    <td className="py-2 pr-3">{formatMoney(line.unitPrice)}</td>
                    <td className="py-2 pr-3">{formatMoney(line.sampleCostFloor)}</td>
                    <td className="py-2 pr-3">{formatMoney(line.priceFloor)}</td>
                    <td className="py-2 pr-3">{(line.marginBps / 100).toFixed(1)}%</td>
                    <td className="max-w-64 break-words py-2 pr-3">
                      {floorSourceLabel(line.floorSource)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {!terminal ? (
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="mx-auto grid max-w-3xl gap-2">
            <Button
              className="min-h-11 md:flex-1"
              variant="primary"
              disabled={busy}
              onClick={() => complete.mutate()}
            >
              {complete.isPending ? "完成中…" : "标记完成"}
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {statusTransitions.map((status) => (
                <Button
                  key={status}
                  className="min-h-11 justify-start"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => transition.mutate(status)}
                >
                  {TRANSITION_LABEL[status] ?? ITEM_STATUS_LABEL[status]}
                </Button>
              ))}
              {canClose ? (
                <div className="md:ml-auto">
                  <button
                    type="button"
                    aria-expanded={moreOpen}
                    onClick={() => {
                      setMoreOpen((open) => !open);
                      setConfirmClose(false);
                    }}
                    className="inline-flex min-h-11 w-full items-center justify-center rounded-md px-4 text-sm text-ink-500 hover:bg-paper hover:text-ink-900"
                  >
                    更多操作
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {moreOpen && canClose ? (
            <div className="mx-auto mt-2 max-w-3xl rounded-md border border-vermilion-600/30 bg-vermilion-600/5 p-3">
              {confirmClose ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-vermilion-600">关闭后不能再改状态，确定关闭？</p>
                  <Button
                    className="min-h-11"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => transition.mutate("CLOSED")}
                  >
                    确定关闭
                  </Button>
                  <Button
                    className="min-h-11"
                    variant="secondary"
                    onClick={() => setConfirmClose(false)}
                  >
                    先不关
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClose(true)}
                  className="inline-flex min-h-11 items-center text-sm text-vermilion-600 underline underline-offset-2"
                >
                  关闭事项（不可撤销）
                </button>
              )}
            </div>
          ) : null}

          {/* 终态有自己的一句结果文案，提示留在这里才不会和它重复。 */}
          {feedback ? (
            <p className="mx-auto mt-2 max-w-3xl text-xs text-ink-400" role="status">
              {feedback}
            </p>
          ) : null}
        </div>
      ) : (
        <Card className="p-4 text-sm text-ink-400">事项已结束，状态与结果保留可查。</Card>
      )}
    </div>
  );
}
