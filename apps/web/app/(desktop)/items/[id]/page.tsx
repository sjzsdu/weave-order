"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemStatus } from "@weave-order/schema";
import { Badge, Button, Card, EmptyState, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { ITEM_STATUS_LABEL, ITEM_STATUS_TONE, itemQuantityText } from "@/item-format";

const TRANSITION_LABEL: Partial<Record<ItemStatus, string>> = {
  WAITING_INPUT: "等待补充",
  WAITING_DECISION: "等待决定",
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

  const transition = useMutation({
    mutationFn: (status: ItemStatus) => api.transitionItem(itemId, { status }),
    onSuccess: (detail) => {
      queryClient.setQueryData(key, detail);
      setFeedback("事项状态已更新");
      setMoreOpen(false);
      setConfirmClose(false);
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "状态更新失败"),
  });
  const complete = useMutation({
    mutationFn: () => api.completeItem(itemId),
    onSuccess: (detail) => {
      queryClient.setQueryData(key, detail);
      setFeedback("事项已完成");
    },
    onError: (error) =>
      setFeedback(error instanceof Error ? error.message : "完成失败：还缺可观察的业务结果"),
  });

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
  const busy = transition.isPending || complete.isPending;

  return (
    <div className="grid gap-4 pb-24 md:pb-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="flex flex-wrap items-center gap-1 text-xs text-ink-400">
            <Link href="/items" className="hover:text-ink-900">
              事项
            </Link>
            <span>/</span>
            <Link href="/resources" className="hover:text-ink-900">
              资源
            </Link>
            <span>/</span>
            <span className="text-ink-700">事项详情</span>
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

      {!terminal ? (
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="mx-auto grid max-w-3xl gap-2 md:flex md:flex-wrap md:items-center">
            <Button
              className="min-h-11 md:flex-1"
              variant="primary"
              disabled={busy}
              onClick={() => complete.mutate()}
            >
              {complete.isPending ? "完成中…" : "标记完成"}
            </Button>
            {statusTransitions.map((status) => (
              <Button
                key={status}
                className="min-h-11 md:flex-1"
                variant="secondary"
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
