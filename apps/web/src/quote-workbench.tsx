"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QuoteDetail } from "@weave-order/schema";
import { Badge, Button, Card, Spinner, formatMoney } from "@weave-order/ui";
import { centsToYuanInput, useTenantContext } from "@weave-order/core";
import { useApi } from "@/providers";
import { confirmedByLabel } from "@/format";
import { ITEM_UNIT_LABEL } from "@/item-format";
import { SampleCardPrint } from "@/sample-card-print";

/**
 * 报价工作面（P0a-5，旅程 A）。
 *
 * 用户的路径只有一条：看依据 → 改价 → 确认价格 → 复制给客户 → 事项完成。
 * 这里没有任何审批队列或审批入口：D1 已取消报价审批，确认即定稿，
 * 只保留确认人留痕（`confirmQuote` 的幂等键保证重复点击不产生第二条审计）。
 */

const QUOTE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "待确认价格",
  SENT: "已确认价格",
  ACCEPTED: "客户已接受",
  REJECTED: "已驳回",
  EXPIRED: "已过期",
};

const QUOTE_STATUS_TONE: Record<string, "warning" | "success" | "neutral" | "danger"> = {
  DRAFT: "warning",
  SENT: "success",
  ACCEPTED: "success",
  REJECTED: "danger",
  EXPIRED: "neutral",
};

function dateText(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function yuanToCents(raw: string): number | null {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

/** diff 里的值可能是金额、数量或纯文本，统一成人能读的一行。 */
function diffValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object" && "amount" in value && "currency" in value) {
    return formatMoney(value as { amount: number; currency: "CNY" });
  }
  if (typeof value === "object" && "value" in value && "unit" in value) {
    const quantity = value as { value: number; unit: string };
    return `${quantity.value} ${ITEM_UNIT_LABEL[quantity.unit] ?? quantity.unit}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function QuoteWorkbench({ itemId, quoteId }: { itemId: string; quoteId: string }) {
  const api = useApi();
  const tenantContext = useTenantContext(api);
  const mySubject = tenantContext.status === "READY" ? tenantContext.membership.subject : null;
  const queryClient = useQueryClient();
  const quoteKey = ["quote", quoteId] as const;

  const quoteQuery = useQuery({
    queryKey: quoteKey,
    queryFn: () => api.quote(quoteId),
  });
  const [basisOpen, setBasisOpen] = useState(false);
  const basisQuery = useQuery({
    queryKey: ["quote", quoteId, "basis"],
    queryFn: () => api.quoteBasis(quoteId),
    enabled: basisOpen,
  });

  const [priceDrafts, setPriceDrafts] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [changeRows, setChangeRows] = useState<
    Array<{ label: string; before: number; after: number; delta: number }>
  >([]);
  const [copied, setCopied] = useState(false);
  // 幂等键在这一次「确认」点击期间保持不变：网络重试拿到同一个结果。
  const confirmKeyRef = useRef<string | null>(null);

  const quote = quoteQuery.data;
  const confirmed = quote?.status === "SENT" || quote?.status === "ACCEPTED";

  const copyQuery = useQuery({
    queryKey: ["quote", quoteId, "copy-text"],
    queryFn: () => api.quoteCopyText(quoteId),
    enabled: Boolean(confirmed),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: quoteKey });
    void queryClient.invalidateQueries({ queryKey: ["quote", quoteId, "basis"] });
    void queryClient.invalidateQueries({ queryKey: ["quote", quoteId, "copy-text"] });
    void queryClient.invalidateQueries({ queryKey: ["item", itemId] });
    void queryClient.invalidateQueries({ queryKey: ["item", itemId, "quotes"] });
    void queryClient.invalidateQueries({ queryKey: ["items"] });
  };

  const revise = useMutation({
    mutationFn: () => {
      if (!quote) throw new Error("报价还没读出来");
      const lines = quote.draft.items
        .map((line) => {
          const raw = priceDrafts[line.lineIndex ?? 0];
          if (raw === undefined) return null;
          const amount = yuanToCents(raw);
          if (amount === null) throw new Error("新单价必须大于 0");
          return {
            lineIndex: line.lineIndex ?? 0,
            unitPrice: { amount, currency: quote.draft.currency },
          };
        })
        .filter((line): line is NonNullable<typeof line> => line !== null);
      if (lines.length === 0) throw new Error("先填一个要改的新单价");
      return api.reviseItemQuote(quoteId, {
        baseVersion: quote.version,
        lines,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    },
    onSuccess: (result) => {
      setChangeRows(
        result.changes.map((change) => ({
          label: `第 ${change.lineIndex + 1} 行 · ${change.sampleCode}`,
          before: change.beforeUnitPrice.amount,
          after: change.afterUnitPrice.amount,
          delta: change.delta.amount,
        })),
      );
      setPriceDrafts({});
      setNote("");
      setFeedback("价格已改，原价保留在依据里");
      setBasisOpen(true);
      invalidate();
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "改价失败"),
  });

  const confirm = useMutation({
    mutationFn: () => {
      if (!quote) throw new Error("报价还没读出来");
      if (!confirmKeyRef.current) {
        confirmKeyRef.current = `confirm-${quoteId}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 10)}`;
      }
      return api.confirmQuote(quoteId, {
        baseVersion: quote.version,
        idempotencyKey: confirmKeyRef.current,
      });
    },
    onSuccess: () => {
      setFeedback("价格已确认，可以直接复制给客户");
      invalidate();
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "确认失败");
    },
  });

  const copy = async () => {
    const text = copyQuery.data?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFeedback("已复制，粘贴到微信/WhatsApp 即可");
    } catch {
      setFeedback("浏览器拒绝了剪贴板权限，请手动全选复制下面的文本");
    }
  };

  const lines = quote?.draft.items ?? [];
  const canConfirm = useMemo(
    () => quote?.status === "DRAFT" && !confirm.isPending,
    [quote?.status, confirm.isPending],
  );

  if (quoteQuery.isLoading) return <Spinner label="正在读取报价…" />;
  if (quoteQuery.isError || !quote) {
    return (
      <Card className="p-4 text-sm text-ink-400">
        报价读不出来：{quoteQuery.error instanceof Error ? quoteQuery.error.message : "请稍后重试"}
      </Card>
    );
  }

  return (
    <div className="grid gap-4 pb-24 md:pb-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="flex flex-wrap items-center gap-1 text-xs text-ink-400">
            <Link href="/items" className="hover:text-ink-900">
              事项
            </Link>
            <span>/</span>
            <Link href={`/items/${itemId}`} className="hover:text-ink-900">
              事项详情
            </Link>
            <span>/</span>
            <span className="text-ink-700">报价</span>
          </nav>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">
            {quote.quoteNumber ?? "报价"} · {formatMoney(quote.draft.total)}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            v{quote.version} ｜ 有效期 {quote.draft.validityDays} 天（至{" "}
            {dateText(quote.draft.expiresAt)}）
            {quote.confirmedBy
              ? ` ｜ 确认人 ${confirmedByLabel(quote.confirmedByName, quote.confirmedBy, mySubject)} · ${dateText(quote.confirmedAt)}`
              : ""}
          </p>
        </div>
        <Badge tone={QUOTE_STATUS_TONE[quote.status] ?? "neutral"}>
          {QUOTE_STATUS_LABEL[quote.status] ?? quote.status}
        </Badge>
      </header>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-ink-700">报价明细</h2>
          <Button variant="secondary" className="min-h-11" onClick={() => setBasisOpen((v) => !v)}>
            {basisOpen ? "收起报价依据" : "查看报价依据"}
          </Button>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-400">
                <th className="py-2 pr-3 font-normal">样品</th>
                <th className="py-2 pr-3 font-normal">数量</th>
                <th className="py-2 pr-3 font-normal">单价</th>
                <th className="py-2 font-normal">金额</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.lineIndex ?? 0} className="border-b border-line/60">
                  <td className="py-2 pr-3 text-ink-900">{line.description}</td>
                  <td className="py-2 pr-3 text-ink-700">
                    {line.quantity.value}{" "}
                    {ITEM_UNIT_LABEL[line.quantity.unit] ?? line.quantity.unit}
                  </td>
                  <td className="py-2 pr-3 text-ink-900">{formatMoney(line.unitPrice)}</td>
                  <td className="py-2 text-ink-900">{formatMoney(line.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {quote.baselineTotal && quote.baselineTotal.amount !== quote.draft.total.amount ? (
          <p className="mt-2 text-xs text-ink-400">
            智能体原稿 {formatMoney(quote.baselineTotal)} → 当前 {formatMoney(quote.draft.total)}
            （原稿保留，依据里可对照）
          </p>
        ) : null}
      </Card>

      {basisOpen ? (
        <Card className="border-l-4 border-l-indigo-600 p-4">
          <h2 className="text-sm font-medium text-ink-700">报价依据（实时查）</h2>
          {basisQuery.isLoading ? <Spinner label="正在查成本与历史价…" /> : null}
          {basisQuery.isError ? (
            <p className="mt-2 text-sm text-vermilion-600">
              {basisQuery.error instanceof Error ? basisQuery.error.message : "依据读取失败"}
            </p>
          ) : null}
          {basisQuery.data ? (
            <div className="mt-3 grid gap-3">
              {basisQuery.data.lines.map((line) => (
                <div key={line.lineIndex} className="rounded-md bg-paper p-3 text-sm">
                  <div className="font-medium text-ink-900">
                    {line.sampleName}（{line.sampleCode}）
                  </div>
                  <dl className="mt-2 grid gap-1 text-ink-700">
                    <div className="flex justify-between gap-2">
                      <dt className="text-ink-400">当前单价</dt>
                      <dd>{formatMoney(line.unitPrice)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-ink-400">样品成本底线</dt>
                      <dd>{formatMoney(line.sampleCostFloor)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-ink-400">公司成本底线</dt>
                      <dd>{formatMoney(line.companyCostFloor)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-ink-400">含最低毛利的底价</dt>
                      <dd>{formatMoney(line.priceFloor)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-ink-400">毛利空间</dt>
                      <dd>
                        {formatMoney(line.marginAmount)}（{(line.marginBps / 100).toFixed(1)}%）
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-1 text-xs text-ink-400">{line.floorSource}</p>
                </div>
              ))}
              <div>
                <h3 className="text-xs uppercase tracking-[0.16em] text-ink-400">
                  历史成交（来源单据）
                </h3>
                {basisQuery.data.history.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-400">这个样品还没有确认过的成交价。</p>
                ) : (
                  <ul className="mt-1 grid gap-1 text-sm">
                    {basisQuery.data.history.map((entry) => (
                      <li
                        key={`${entry.quoteId}-${entry.unitPrice.amount}`}
                        className="flex flex-wrap justify-between gap-2 border-b border-line/60 py-1"
                      >
                        <span className="text-ink-900">
                          {entry.customerName} · {entry.quoteNumber}
                        </span>
                        <span className="text-ink-700">
                          {formatMoney(entry.unitPrice)} ｜ {dateText(entry.confirmedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {basisQuery.data.lastDealUnitPrice ? (
                  <p className="mt-2 text-xs text-ink-500">
                    最近一次成交：{formatMoney(basisQuery.data.lastDealUnitPrice)}（
                    {dateText(basisQuery.data.lastDealAt)}）
                  </p>
                ) : null}
              </div>
              <div>
                <h3 className="text-xs uppercase tracking-[0.16em] text-ink-400">原稿与差异</h3>
                <p className="mt-1 text-sm text-ink-700">
                  智能体原稿：{quote.baselineTotal ? formatMoney(quote.baselineTotal) : "—"}
                  {" → "}
                  当前：{formatMoney(quote.draft.total)}
                </p>
                {quote.pendingDiff.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-400">当前价格与智能体原稿一致。</p>
                ) : (
                  <ul className="mt-1 grid gap-1 text-sm">
                    {quote.pendingDiff.map((entry) => (
                      <li
                        key={`${entry.field}-${entry.lineIndex ?? "doc"}`}
                        className="flex flex-wrap gap-2 text-ink-700"
                      >
                        <span className="text-ink-400">
                          {entry.label ?? entry.field}
                          {entry.lineIndex !== null && entry.lineIndex !== undefined
                            ? `（第 ${entry.lineIndex + 1} 行）`
                            : ""}
                        </span>
                        <span className="line-through">{diffValue(entry.before)}</span>
                        <span aria-hidden>→</span>
                        <span className="text-ink-900">{diffValue(entry.after)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {changeRows.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-medium text-ink-700">本次改价</h2>
          <ul className="mt-2 grid gap-1 text-sm">
            {changeRows.map((row) => (
              <li key={row.label} className="flex flex-wrap items-center gap-2">
                <span className="text-ink-400">{row.label}</span>
                <span className="text-ink-500 line-through">¥{centsToYuanInput(row.before)}</span>
                <span aria-hidden>→</span>
                <span className="font-medium text-ink-900">¥{centsToYuanInput(row.after)}</span>
                <span className={row.delta >= 0 ? "text-emerald-700" : "text-vermilion-600"}>
                  {row.delta >= 0 ? "+" : ""}¥{centsToYuanInput(row.delta)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {quote.status === "DRAFT" ? (
        <Card className="p-4">
          <h2 className="text-sm font-medium text-ink-700">改价</h2>
          <div className="mt-3 grid gap-2">
            {lines.map((line) => (
              <label
                key={line.lineIndex ?? 0}
                className="grid gap-1 text-sm sm:grid-cols-[1fr_10rem] sm:items-center"
              >
                <span className="text-ink-700">
                  {line.description}（当前 {formatMoney(line.unitPrice)}）
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder={centsToYuanInput(line.unitPrice.amount)}
                  value={priceDrafts[line.lineIndex ?? 0] ?? ""}
                  onChange={(event) =>
                    setPriceDrafts((drafts) => ({
                      ...drafts,
                      [line.lineIndex ?? 0]: event.target.value,
                    }))
                  }
                  className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
                  aria-label={`改第 ${(line.lineIndex ?? 0) + 1} 行单价`}
                />
              </label>
            ))}
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="改价原因（可不填）"
              className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                className="min-h-11"
                disabled={revise.isPending}
                onClick={() => revise.mutate()}
              >
                {revise.isPending ? "正在改价…" : "保存新价格"}
              </Button>
              <span className="text-xs text-ink-400">改价不会丢掉原价，依据里能对照。</span>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="mx-auto grid max-w-3xl gap-2 md:flex md:flex-wrap md:items-center">
          {confirmed ? (
            <Button className="min-h-11 md:flex-1" variant="primary" onClick={() => void copy()}>
              {copied ? "已复制报价文本" : "复制报价文本"}
            </Button>
          ) : (
            <Button
              className="min-h-11 md:flex-1"
              variant="primary"
              disabled={!canConfirm}
              onClick={() => confirm.mutate()}
            >
              {confirm.isPending ? "确认中…" : "确认价格"}
            </Button>
          )}
          <Link
            href={`/items/${itemId}`}
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-line px-4 text-sm text-ink-900 hover:bg-paper md:flex-1"
          >
            回到事项
          </Link>
        </div>
        {!confirmed ? (
          <p className="mx-auto mt-2 max-w-3xl text-xs text-ink-400">
            确认价格即定稿，不需要任何人再审批；确认人和时间会记入审计。
          </p>
        ) : null}
        {feedback ? (
          <p className="mx-auto mt-2 max-w-3xl text-xs text-ink-400" role="status">
            {feedback}
          </p>
        ) : null}
      </div>

      {confirmed ? <SampleCardPrint quoteId={quoteId} /> : null}

      {confirmed && copyQuery.data ? (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-ink-700">发给客户的文本</h2>
            <Button variant="secondary" className="min-h-11" onClick={() => void copy()}>
              一键复制
            </Button>
          </div>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-paper p-3 text-sm text-ink-900">
            {copyQuery.data.text}
          </pre>
        </Card>
      ) : null}
    </div>
  );
}

/** 让「已确认」的徽标也能被测试与页面复用。 */
export function quoteStatusLabel(status: QuoteDetail["status"]): string {
  return QUOTE_STATUS_LABEL[status] ?? status;
}
