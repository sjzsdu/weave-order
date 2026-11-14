"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ReceivableListItem } from "@weave-order/schema";
import { useReceivableList, useRecordPayment } from "@weave-order/core";
import type { ReceivableBucketFilter } from "@weave-order/core";
import { Badge, Button, EmptyState, MoneyText, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { RECEIVABLE_STATUS_LABEL, plainCents } from "@/format";

const BUCKETS: Array<{ key: ReceivableBucketFilter; label: string }> = [
  { key: "overdue", label: "逾期" },
  { key: "dueSoon", label: "本月到期" },
  { key: "settled", label: "已结清" },
  { key: "all", label: "全部" },
];

function toCsv(rows: ReceivableListItem[]): string {
  const header = ["客户", "订单号", "金额", "已收", "余额", "到期日", "状态", "逾期天数"];
  const lines = rows.map((row) => [
    row.customerName,
    row.orderCode,
    plainCents(row.amount.amount),
    plainCents(row.paidAmount.amount),
    plainCents(row.balance.amount),
    new Date(row.dueDate).toISOString().slice(0, 10),
    RECEIVABLE_STATUS_LABEL[row.status] ?? row.status,
    String(row.daysOverdue),
  ]);
  return [header, ...lines]
    .map((cells) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

/**
 * 应收与对账：全景 → 应收与对账。
 *
 * 三个分组计数与未收余额都由服务端一次算好；登记回款后失效同一组 query key，
 * 表格、分组数字与全景同步刷新，不靠页面自己重算。
 */
export default function ReceivablesPage() {
  const mounted = useMounted();
  if (!mounted) return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  return <ReceivablesPageContent />;
}

function ReceivablesPageContent() {
  const api = useApi();
  const [bucket, setBucket] = useState<ReceivableBucketFilter>("overdue");
  const filters = useMemo(() => ({ bucket }), [bucket]);
  const list = useReceivableList(api, filters);
  const [payTarget, setPayTarget] = useState<ReceivableListItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function downloadCsv() {
    const blob = new Blob([`\uFEFF${toCsv(list.items)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `应收-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const summary = list.summary;

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/panorama" className="text-xs text-ink-400 underline underline-offset-2">
            ← 回全景
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">应收与对账</h1>
          <p className="mt-1 text-sm text-ink-400">
            逾期先看 · 本月到期次之 · 已结清留档
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="min-h-9 px-3 text-xs"
            onClick={downloadCsv}
            disabled={list.items.length === 0}
          >
            导出当前列表
          </Button>
          <Link
            href="/panorama/orders"
            className="inline-flex min-h-9 items-center rounded-md border border-line bg-surface px-3 text-sm text-ink-700 hover:border-ink-400"
          >
            ← 去报价与订单
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {BUCKETS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setBucket(item.key)}
            aria-pressed={bucket === item.key}
            className={cn(
              "rounded-lg border bg-surface px-4 py-3 text-left transition-colors",
              bucket === item.key
                ? "border-indigo-600 ring-1 ring-indigo-600/30"
                : "border-line hover:border-ink-400",
            )}
          >
            <div className="text-xs text-ink-400">{item.label}</div>
            <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-ink-900">
              {item.key === "all" ? "—" : (summary?.[item.key] ?? 0)}
            </div>
            {item.key === "all" && summary && (
              <div className="mt-1 text-xs text-ink-400">
                未收{" "}
                {summary.balanceByCurrency.length === 0
                  ? "—"
                  : summary.balanceByCurrency
                      .map((total) => `${plainCents(total.amount)} ${total.currency}`)
                      .join(" · ")}
              </div>
            )}
          </button>
        ))}
      </section>

      {notice && (
        <p className="rounded-md border border-moss-600/30 bg-moss-600/10 px-3 py-2 text-sm text-moss-600">
          {notice}
        </p>
      )}

      {list.isLoading ? (
        <Spinner label="正在读取应收…" />
      ) : list.isError ? (
        <EmptyState
          title="应收暂时读不出来"
          description={list.error instanceof Error ? list.error.message : "请稍后重试"}
        />
      ) : list.items.length === 0 ? (
        <EmptyState
          title={bucket === "overdue" ? "没有逾期的应收" : "这个分组没有单据"}
          description="订单确认后建了应收，就会出现在这里。"
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">客户</th>
                <th className="px-3 py-2 text-left font-normal">订单</th>
                <th className="px-3 py-2 text-right font-normal">应收</th>
                <th className="px-3 py-2 text-right font-normal">已收</th>
                <th className="px-3 py-2 text-right font-normal">余额</th>
                <th className="px-3 py-2 text-left font-normal">到期日</th>
                <th className="px-3 py-2 text-left font-normal">状态</th>
                <th className="px-3 py-2 text-right font-normal">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.items.map((item) => {
                const overdue = item.status === "OVERDUE";
                const settled = item.status === "PAID";
                return (
                  <tr key={item.id} className={cn(overdue && "bg-vermilion-100/40")}>
                    <td className="px-3 py-2">
                      <div className="text-ink-900">{item.customerName}</div>
                      <div className="text-xs text-ink-400">{item.customerCode}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-700">{item.orderCode}</td>
                    <td className="px-3 py-2 text-right">
                      <MoneyText money={item.amount} size="sm" />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyText money={item.paidAmount} size="sm" muted />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyText money={item.balance} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-ink-700">
                        {new Date(item.dueDate).toLocaleDateString("zh-CN")}
                      </div>
                      {overdue && (
                        <div className="text-xs text-vermilion-600">逾期 {item.daysOverdue} 天</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={
                          overdue
                            ? "danger"
                            : settled
                              ? "success"
                              : item.status === "PARTIAL"
                                ? "info"
                                : "neutral"
                        }
                      >
                        {RECEIVABLE_STATUS_LABEL[item.status] ?? item.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-2">
                        {!settled && (
                          <Button
                            variant="secondary"
                            className="min-h-9 px-3 text-xs"
                            onClick={() => {
                              setNotice(null);
                              setPayTarget(item);
                            }}
                          >
                            登记回款
                          </Button>
                        )}
                        <Link
                          href={`/panorama/receivables/statement?customerId=${item.customerId}&customerName=${encodeURIComponent(item.customerName)}`}
                          className="inline-flex min-h-9 items-center rounded-md border border-line bg-surface px-3 text-xs text-ink-700 hover:border-ink-400"
                        >
                          对账单
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "正在加载…" : "加载更多"}
          </Button>
        </div>
      )}

      {payTarget && (
        <PaymentModal
          item={payTarget}
          onClose={() => setPayTarget(null)}
          onDone={(message) => {
            setPayTarget(null);
            setNotice(message);
          }}
        />
      )}
    </div>
  );
}

function parseYuanToCents(raw: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedMime = (typeof ALLOWED_MIME)[number];

function PaymentModal({
  item,
  onClose,
  onDone,
}: {
  item: ReceivableListItem;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const api = useApi();
  const record = useRecordPayment(api, item.id);
  const [amount, setAmount] = useState(plainCents(item.balance.amount));
  const today = new Date().toISOString().slice(0, 10);
  const [paidAt, setPaidAt] = useState(today);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    const cents = parseYuanToCents(amount);
    if (cents === null || cents <= 0) {
      setError("金额格式不对：最多两位小数，且必须大于 0");
      return;
    }
    if (cents > item.balance.amount) {
      setError(`超过未收余额 ${plainCents(item.balance.amount)} ${item.balance.currency}`);
      return;
    }
    setBusy(true);
    try {
      let proofObjectKey: string | null = null;
      if (file) {
        const mimeType = file.type as AllowedMime;
        if (!ALLOWED_MIME.includes(mimeType)) {
          throw new Error("凭证只支持 jpg / png / webp");
        }
        const presign = await api.presignReceipt({
          receivableId: item.id,
          mimeType,
          byteSize: file.size,
        });
        const upload = await fetch(presign.uploadUrl, {
          method: presign.method,
          headers: presign.headers,
          body: file,
        });
        if (!upload.ok) throw new Error(`凭证上传失败（HTTP ${upload.status}）`);
        proofObjectKey = presign.objectKey;
      }
      await record.mutateAsync({
        amount: { amount: cents, currency: item.amount.currency },
        paidAt: new Date(`${paidAt}T12:00:00`).toISOString(),
        note: note.trim() || null,
        proofObjectKey,
      });
      onDone(`已登记 ${plainCents(cents)} ${item.amount.currency} 回款，余额与分组已刷新。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登记失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="登记回款"
      className="fixed inset-0 z-40 flex items-end justify-center bg-ink-900/30 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-5 shadow-card">
        <header className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-900">登记回款</h2>
            <p className="mt-1 text-xs text-ink-400">
              {item.customerName} · {item.orderCode} · 未收{" "}
              <MoneyText money={item.balance} size="sm" />
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-ink-400 hover:text-ink-700">
            关闭
          </button>
        </header>

        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-xs text-ink-400">
            金额（{item.amount.currency}）
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              className="min-h-10 rounded-md border border-line bg-surface px-3 font-mono text-sm text-ink-900"
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-400">
            到账日期
            <input
              type="date"
              value={paidAt}
              onChange={(event) => setPaidAt(event.target.value)}
              className="min-h-10 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-400">
            备注（选填）
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={255}
              placeholder="如：银行转账尾号 1234"
              className="min-h-10 rounded-md border border-line bg-surface px-3 text-sm text-ink-900"
            />
          </label>
          <label className="grid gap-1 text-xs text-ink-400">
            凭证图（选填，jpg/png/webp）
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="text-sm text-ink-700"
            />
          </label>
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-vermilion-600/30 bg-vermilion-600/10 px-3 py-2 text-xs text-vermilion-600">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "正在记账…" : "确认登记"}
          </Button>
        </div>
      </div>
    </div>
  );
}
