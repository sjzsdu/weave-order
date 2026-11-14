"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useCustomerStatement } from "@weave-order/core";
import { Badge, Button, EmptyState, MoneyText, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { RECEIVABLE_STATUS_LABEL, plainCents, relativeTime } from "@/format";

/**
 * 客户对账单：哪几笔订单、哪几笔回款，一行一笔来源。
 * 页面与打印共用同一份服务端汇总（整数分），没有前端二次计算。
 */
export default function StatementPage() {
  return (
    <Suspense fallback={<Spinner label="正在读取对账单…" />}>
      <StatementContent />
    </Suspense>
  );
}

function StatementContent() {
  const params = useSearchParams();
  const api = useApi();
  const customerId = params.get("customerId");
  const customerName = params.get("customerName") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const statement = useCustomerStatement(api, customerId, {
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  });

  if (!customerId) {
    return <EmptyState title="缺少客户" description="请从应收列表点「对账单」进入。" />;
  }
  if (statement.isLoading) return <Spinner label="正在核对账目…" />;
  if (statement.isError || !statement.data) {
    return (
      <EmptyState
        title="对账单读不出来"
        description={statement.error instanceof Error ? statement.error.message : "请稍后重试"}
        actions={
          <Link href="/panorama/receivables" className="text-sm text-indigo-600 underline">
            回应收与对账
          </Link>
        }
      />
    );
  }

  const data = statement.data;
  const title = data.customer.name || customerName;

  return (
    <div className="grid gap-5 print:gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/panorama/receivables"
            className="no-print text-xs text-ink-400 underline underline-offset-2"
          >
            ← 回应收与对账
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">客户对账单 · {title}</h1>
          <p className="mt-1 text-sm text-ink-400">
            {data.customer.code} ·{" "}
            {data.from && data.to
              ? `${new Date(data.from).toLocaleDateString("zh-CN")} 至 ${new Date(data.to).toLocaleDateString("zh-CN")}`
              : "全部账期"}{" "}
            · 生成于 {new Date(data.generatedAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <div className="no-print flex items-center gap-2">
          <label className="text-xs text-ink-400">
            从
            <input
              type="date"
              defaultValue={from}
              onChange={(event) => {
                const next = new URLSearchParams(params.toString());
                if (event.target.value) next.set("from", event.target.value);
                else next.delete("from");
                window.location.search = next.toString();
              }}
              className="ml-1 min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
            />
          </label>
          <label className="text-xs text-ink-400">
            到
            <input
              type="date"
              defaultValue={to}
              onChange={(event) => {
                const next = new URLSearchParams(params.toString());
                if (event.target.value) next.set("to", event.target.value);
                else next.delete("to");
                window.location.search = next.toString();
              }}
              className="ml-1 min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
            />
          </label>
          <Button
            variant="secondary"
            className="min-h-9 px-3 text-xs"
            onClick={() => window.print()}
          >
            打印对账单
          </Button>
        </div>
      </header>

      <section className="grid gap-2 rounded-lg border border-line bg-surface px-4 py-3 print:border-0 print:px-0">
        <h2 className="text-sm font-medium text-ink-700">汇总（按币种）</h2>
        {data.totalsByCurrency.length === 0 ? (
          <p className="text-sm text-ink-400">该账期没有应收。</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-400">
              <tr>
                <th className="py-1 text-left font-normal">币种</th>
                <th className="py-1 text-right font-normal">应收合计</th>
                <th className="py-1 text-right font-normal">已收合计</th>
                <th className="py-1 text-right font-normal">未收余额</th>
              </tr>
            </thead>
            <tbody>
              {data.totalsByCurrency.map((total) => (
                <tr key={total.currency} className="border-t border-line">
                  <td className="py-1 font-mono">{total.currency}</td>
                  <td className="py-1 text-right">
                    <MoneyText money={{ amount: total.amount, currency: total.currency }} />
                  </td>
                  <td className="py-1 text-right">
                    <MoneyText money={{ amount: total.paid, currency: total.currency }} />
                  </td>
                  <td className="py-1 text-right">
                    <MoneyText money={{ amount: total.balance, currency: total.currency }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.legacyPaidByCurrency.length > 0 && (
          <p className="text-xs text-ink-400">
            其中历史收款（无逐笔流水）：
            {data.legacyPaidByCurrency
              .map((item) => `${plainCents(item.amount)} ${item.currency}`)
              .join(" · ")}
            。这些款项发生在回款流水上线之前，仅保留累计值。
          </p>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="text-sm font-medium text-ink-700">订单与回款明细</h2>
        {data.lines.length === 0 ? (
          <EmptyState title="没有可对账的单据" description="换个账期，或先给订单建应收。" />
        ) : (
          <div className="grid gap-3">
            {data.lines.map((line) => {
              const balance = line.receivable.amount.amount - line.receivable.paidAmount.amount;
              const currency = line.receivable.amount.currency;
              return (
                <article
                  key={line.receivable.id}
                  className="rounded-lg border border-line bg-surface px-4 py-3 print:break-inside-avoid"
                >
                  <header className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <div className="font-mono text-sm text-ink-900">{line.orderCode}</div>
                      <div className="text-xs text-ink-400">
                        到期 {new Date(line.receivable.dueDate).toLocaleDateString("zh-CN")} ·{" "}
                        {RECEIVABLE_STATUS_LABEL[line.receivable.status] ?? line.receivable.status}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="text-xs text-ink-400">
                        应收 <MoneyText money={line.receivable.amount} size="sm" />
                      </span>
                      <span className="text-xs text-ink-400">
                        已收 <MoneyText money={line.receivable.paidAmount} size="sm" />
                      </span>
                      <Badge tone={balance === 0 ? "success" : "warning"}>
                        未收 <MoneyText money={{ amount: balance, currency }} size="sm" />
                      </Badge>
                    </div>
                  </header>

                  <table className="mt-3 w-full text-xs">
                    <thead className="text-ink-400">
                      <tr>
                        <th className="w-44 py-1 text-left font-normal">回款日期</th>
                        <th className="w-32 py-1 pr-6 text-right font-normal">金额</th>
                        <th className="py-1 pl-4 text-left font-normal">备注</th>
                        <th className="w-16 py-1 text-right font-normal">凭证</th>
                      </tr>
                    </thead>
                    <tbody className="text-ink-700">
                      {line.payments.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-1 text-ink-400">
                            暂无逐笔回款记录。
                          </td>
                        </tr>
                      ) : (
                        line.payments.map((payment) => (
                          <tr key={payment.id} className="border-t border-line">
                            <td className="py-1">
                              {new Date(payment.paidAt).toLocaleDateString("zh-CN")}
                              <span className="ml-2 text-ink-400">
                                {relativeTime(payment.createdAt)}
                              </span>
                            </td>
                            <td className="py-1 pr-6 text-right">
                              <MoneyText money={payment.amount} size="sm" />
                            </td>
                            <td className="py-1 pl-4">{payment.note ?? "—"}</td>
                            <td className="py-1 text-right">
                              {payment.proofUrl ? (
                                <a
                                  href={payment.proofUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-indigo-600 underline underline-offset-2"
                                >
                                  查看
                                </a>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer className="border-t border-line pt-3 text-xs text-ink-400">
        本对账单由织序按账本生成，金额为服务端整数分汇总；如有差异请以回款流水为准。
      </footer>
    </div>
  );
}
