"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemStatus } from "@weave-order/schema";
import { Badge, Button, Card, EmptyState, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";

const STATUS_LABEL: Record<ItemStatus, string> = {
  IN_PROGRESS: "处理中",
  WAITING_INPUT: "等待补充",
  WAITING_DECISION: "等待决定",
  COMPLETED: "已完成",
  CLOSED: "已关闭",
};

const STATUS_TONE: Record<ItemStatus, "success" | "warning" | "danger" | "info" | "neutral"> = {
  IN_PROGRESS: "info",
  WAITING_INPUT: "warning",
  WAITING_DECISION: "warning",
  COMPLETED: "success",
  CLOSED: "neutral",
};

const TRANSITION_LABEL: Partial<Record<ItemStatus, string>> = {
  WAITING_INPUT: "标记为等待补充",
  WAITING_DECISION: "标记为等待决定",
  IN_PROGRESS: "回到处理中",
  CLOSED: "关闭事项",
};

const UNIT_LABEL: Record<string, string> = {
  meter: "米",
  kilogram: "千克",
  yard: "码",
  piece: "件",
};

/**
 * 事项详情（P0a）：状态、客户、样品、数量、当前阶段、下一步动作。
 * 「完成」只有在存在可观察业务结果时才会成功，失败原因直接展示给用户。
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

  const transition = useMutation({
    mutationFn: (status: ItemStatus) => api.transitionItem(itemId, { status }),
    onSuccess: (detail) => {
      queryClient.setQueryData(key, detail);
      setFeedback("事项状态已更新");
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
  const quantity = (item.quantityMilli ?? 0) / 1000;
  const terminal = item.status === "COMPLETED" || item.status === "CLOSED";

  return (
    <div className="grid gap-4 pb-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="flex items-center gap-1 text-xs text-ink-400">
            <Link href="/today" className="hover:text-ink-900">
              工作台
            </Link>
            <span>/</span>
            <span className="text-ink-700">事项</span>
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
        <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-medium text-ink-700">事项</h2>
          <dl className="mt-3 grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-400">数量</dt>
              <dd className="text-ink-900">
                {quantity.toLocaleString("zh-CN")} {UNIT_LABEL[item.unit] ?? item.unit}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-400">当前阶段</dt>
              <dd className="text-ink-900">{item.currentStage ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-400">下一步</dt>
              <dd className="text-ink-900">{item.nextAction ?? "—"}</dd>
            </div>
          </dl>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-medium text-ink-700">资源</h2>
          <div className="mt-3 grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-400">客户</span>
              {customer ? (
                <Link
                  href={`/panorama/customers/${customer.id}`}
                  className="min-h-11 text-ink-900 underline underline-offset-2"
                >
                  {customer.name}
                </Link>
              ) : (
                <span className="text-ink-400">待补充</span>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-400">样品</span>
              {sample ? (
                <Link
                  href={`/panorama/samples/${sample.id}/review`}
                  className="min-h-11 text-ink-900 underline underline-offset-2"
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
          <div className="mx-auto grid max-w-3xl grid-cols-2 gap-2 md:flex md:flex-wrap">
            <Button
              className="min-h-11 md:flex-1"
              disabled={complete.isPending}
              onClick={() => complete.mutate()}
            >
              {complete.isPending ? "完成中…" : "标记完成"}
            </Button>
            {allowedTransitions
              .filter((status) => status !== "COMPLETED")
              .map((status) => (
                <Button
                  key={status}
                  className="min-h-11 md:flex-1"
                  variant="secondary"
                  disabled={transition.isPending}
                  onClick={() => transition.mutate(status)}
                >
                  {TRANSITION_LABEL[status] ?? STATUS_LABEL[status]}
                </Button>
              ))}
          </div>
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
