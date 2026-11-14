"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { Shipment } from "@weave-order/schema";
import { useOrderWorkbench } from "@weave-order/core";
import { Badge, EmptyState, MoneyText, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { ORDER_STATUS_LABEL, STATUS_LABEL, relativeTime } from "@/format";

/**
 * 订单详情：行项目 / 关联报价 / 寄样记录 / 发货记录。
 * 这里不提供写操作 —— 发货、打印都在 `/shipping/[orderId]` 的流水线上完成。
 */
export default function OrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = params?.orderId ?? null;
  const api = useApi();
  const workbench = useOrderWorkbench(api, orderId);

  if (workbench.isLoading) return <Spinner label="正在读取订单…" />;
  if (workbench.isError || !workbench.data) {
    return (
      <EmptyState
        title="找不到这张订单"
        description={workbench.error instanceof Error ? workbench.error.message : "请从订单列表重新进入"}
        actions={
          <Link href="/panorama/orders" className="text-sm text-indigo-600 underline underline-offset-2">
            回订单列表
          </Link>
        }
      />
    );
  }

  const { order, customer, quote, shipments, sampleShipments } = workbench.data;
  const shippedByLine = new Map<string, number>();
  for (const shipment of shipments) {
    if (shipment.status === "CANCELLED") continue;
    for (const item of shipment.items) {
      shippedByLine.set(
        item.orderItemId,
        (shippedByLine.get(item.orderItemId) ?? 0) + item.quantity.value,
      );
    }
  }
  const totalShippedLines = order.items.filter(
    (item) => (shippedByLine.get(item.id) ?? 0) >= item.quantity.value,
  ).length;

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/panorama/orders" className="text-xs text-ink-400 underline underline-offset-2">
            ← 回订单列表
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">{order.code}</h1>
          <p className="mt-1 text-sm text-ink-400">
            {customer.name} · {customer.code} · 交期{" "}
            {order.dueDate ? new Date(order.dueDate).toLocaleDateString("zh-CN") : "未定"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={order.status === "CANCELLED" ? "danger" : "info"}>
            {ORDER_STATUS_LABEL[order.status] ?? order.status}
          </Badge>
          <MoneyText money={order.total} size="lg" />
          <Link
            href={`/shipping/${order.id}`}
            className="inline-flex min-h-9 items-center rounded-md border border-line bg-surface px-3 text-sm text-ink-700 hover:border-ink-400"
          >
            发货 / 打印 →
          </Link>
        </div>
      </header>

      <section className="grid content-start gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink-700">行项目</h2>
          <span className="text-xs text-ink-400">
            已发 {totalShippedLines}/{order.items.length} 行
          </span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">品名</th>
                <th className="px-3 py-2 text-right font-normal">数量</th>
                <th className="px-3 py-2 text-right font-normal">单价</th>
                <th className="px-3 py-2 text-right font-normal">金额</th>
                <th className="px-3 py-2 text-right font-normal">已发 / 未发</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {order.items.map((item) => {
                const shipped = Math.min(shippedByLine.get(item.id) ?? 0, item.quantity.value);
                return (
                  <tr key={item.id}>
                    <td className="px-3 py-2 text-ink-900">{item.description}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-700">
                      {item.quantity.value.toLocaleString("zh-CN")} {item.quantity.unit}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyText money={item.unitPrice} size="sm" />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyText money={item.lineTotal} size="sm" />
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-xs text-ink-400">
                      {shipped.toLocaleString("zh-CN")} /{" "}
                      {(item.quantity.value - shipped).toLocaleString("zh-CN")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="grid content-start gap-2 rounded-lg border border-line bg-surface px-4 py-3">
          <h2 className="text-sm font-medium text-ink-700">关联报价</h2>
          {quote ? (
            <div className="text-sm text-ink-700">
              <div className="font-mono text-xs text-ink-400">{quote.id.slice(0, 8)}</div>
              <div className="mt-1 flex items-center justify-between">
                <span>{STATUS_LABEL[quote.status] ?? quote.status}</span>
                <MoneyText money={quote.total} size="sm" />
              </div>
              <div className="mt-1 text-xs text-ink-400">{relativeTime(quote.createdAt)}生成</div>
              <Link
                href="/approvals"
                className="mt-2 inline-block text-xs text-indigo-600 underline underline-offset-2"
              >
                去审批窗口查看报价来源
              </Link>
            </div>
          ) : (
            <p className="text-sm text-ink-400">直接下单，没有关联报价。</p>
          )}
        </section>

        <section className="grid content-start gap-2 rounded-lg border border-line bg-surface px-4 py-3">
          <h2 className="text-sm font-medium text-ink-700">寄样记录（该客户最近 5 次）</h2>
          {sampleShipments.length === 0 ? (
            <p className="text-sm text-ink-400">还没有寄样记录。</p>
          ) : (
            <ul className="grid gap-2">
              {sampleShipments.map((shipment) => (
                <li key={shipment.id} className="text-sm text-ink-700">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-ink-400">
                      {shipment.id.slice(0, 8)}
                    </span>
                    <Badge tone={shipment.status === "CONFIRMED" ? "success" : "neutral"}>
                      {STATUS_LABEL[shipment.status] ?? shipment.status}
                    </Badge>
                  </div>
                  <div className="text-xs text-ink-400">
                    {shipment.items.length} 件 · {shipment.carrier ?? "未填承运"} ·{" "}
                    {relativeTime(shipment.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="grid content-start gap-2 rounded-lg border border-line bg-surface px-4 py-3">
          <h2 className="text-sm font-medium text-ink-700">发货记录</h2>
          {shipments.length === 0 ? (
            <p className="text-sm text-ink-400">还没有发货单。</p>
          ) : (
            <ul className="grid gap-2">
              {shipments.map((shipment: Shipment) => (
                <li key={shipment.id} className="text-sm text-ink-700">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-ink-400">
                      SH-{shipment.id.slice(0, 8).toUpperCase()}
                    </span>
                    <Badge tone={shipment.status === "SHIPPED" ? "success" : "neutral"}>
                      {STATUS_LABEL[shipment.status] ?? shipment.status}
                    </Badge>
                  </div>
                  <div className="text-xs text-ink-400">
                    {shipment.trackingNumber ?? shipment.carrier ?? "未填物流"} ·{" "}
                    {relativeTime(shipment.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Link
            href={`/shipping/${order.id}`}
            className="mt-1 text-xs text-indigo-600 underline underline-offset-2"
          >
            去发货流水线（建单 / 扫码 / 打印）
          </Link>
        </section>
      </div>
    </div>
  );
}
