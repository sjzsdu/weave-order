"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  useApprovals,
  useDecideApproval,
  usePanorama,
  useShippingPending,
} from "@weave-order/core";
import {
  AgentRunStrip,
  Badge,
  Button,
  EmptyState,
  IntentComposer,
  MoneyText,
  Spinner,
  cn,
} from "@weave-order/ui";
import type { AgentRun } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { actionLabel, KIND_LABEL, relativeTime } from "@/format";

function agentName(action: string): string {
  if (action.startsWith("SAMPLE_SHIPMENT")) return "小跟";
  if (action.startsWith("QUOTE")) return "小织";
  if (action.startsWith("REVISION")) return "小织";
  return "小序";
}

export default function TodayPage() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <TodayPageContent />;
}

function TodayPageContent() {
  const api = useApi();
  const panorama = usePanorama(api);
  const approvals = useApprovals(api);
  const shipping = useShippingPending(api);
  const decide = useDecideApproval(api);
  const [notice, setNotice] = useState<string | null>(null);
  const [intents, setIntents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const runs = useMemo<AgentRun[]>(() => {
    const fromAudit = (panorama.data?.audit ?? []).slice(0, 5).map((entry) => ({
      id: entry.id,
      agent: agentName(entry.action),
      what: actionLabel(entry.action),
      status: "done" as const,
      hint: `${entry.actorType === "AGENT" ? "自主完成" : "人工操作"} · ${relativeTime(entry.createdAt)}`,
    }));
    const local = intents.map((text, index) => ({
      id: `local-${index}`,
      agent: "小织",
      what: "已收到你的话，正在拆解需求",
      status: "waiting" as const,
      hint: text,
    }));
    return [...local, ...fromAudit];
  }, [panorama.data, intents]);

  const pending = approvals.data?.items ?? [];
  const stats = panorama.data?.stats;
  const loading = panorama.isLoading || approvals.isLoading;

  async function approve(id: string, kind: "quote" | "sample_shipment") {
    setError(null);
    setNotice(null);
    try {
      const result = await decide.mutateAsync({ id, kind, decision: "APPROVE" });
      if (result.ok) {
        setNotice("已批准，报价已发给客户，后面的跟进会自动排上。");
      } else {
        setError(result.error.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批准失败，请稍后重试");
    }
  }

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-line bg-surface px-6 py-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">工作台</p>
            {loading ? (
              <div className="mt-2">
                <Spinner label="正在汇总今天的事…" />
              </div>
            ) : (
              <h1 className="mt-1 text-2xl font-semibold text-ink-900">
                今天，小织替你做了 {stats?.auditCount ?? 0} 件事，
                <span className={pending.length > 0 ? "text-vermilion-600" : "text-moss-600"}>
                  {" "}
                  {pending.length} 件等你决定
                </span>
              </h1>
            )}
            <p className="mt-1 text-sm text-ink-400">
              每一行都能一键展开为决定；智能体说人话，也说得清依据。
            </p>
          </div>
          <div className="flex gap-2">
            {stats && (
              <>
                <Badge tone="info">客户 {stats.customerCount}</Badge>
                <Badge tone="info">样品 {stats.sampleCount}</Badge>
                <Badge tone="info">草稿待批 {stats.pendingCount}</Badge>
              </>
            )}
          </div>
        </div>
        {notice && (
          <p className="mt-3 rounded-md border border-moss-600/30 bg-moss-600/10 px-3 py-2 text-sm text-moss-600">
            {notice}
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-md border border-vermilion-600/30 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
            {error}
          </p>
        )}
      </section>

      {(shipping.data?.length ?? 0) > 0 && (
        <section className="rounded-lg border border-line bg-surface px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-ink-700">待发货</h2>
              <p className="mt-0.5 text-xs text-ink-400">
                扫码拣货 → 建箱 → 一键打「拣货单 + 箱唛 + 发货单」→ 扫码复核。
              </p>
            </div>
            <Badge tone="info">{shipping.data?.length} 单</Badge>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {shipping.data?.slice(0, 4).map((item) => (
              <Link
                key={item.orderId}
                href={`/shipping/${item.orderId}`}
                className="flex items-center justify-between rounded-md border border-line px-3 py-2 hover:border-indigo-600"
              >
                <span>
                  <span className="text-sm font-medium text-ink-900">{item.orderNo}</span>
                  <span className="ml-2 text-xs text-ink-400">{item.customerName}</span>
                  {item.hasDiscrepancy && (
                    <Badge tone="danger" className="ml-2">
                      差异
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-ink-400">
                  发 {item.shippedQuantity} / {item.totalQuantity} · {item.shipmentCount} 张
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <section className="grid content-start gap-3">
          <h2 className="text-sm font-medium text-ink-700">等你决定</h2>
          {approvals.isLoading && <Spinner />}
          {!approvals.isLoading && pending.length === 0 && (
            <EmptyState
              title="今天没有要你决定的事。"
              description="小织在跟 12 个客户；新的草稿会出现在这里。"
              actions={
                <Link
                  href="/panorama"
                  className="text-sm text-indigo-600 underline underline-offset-2"
                >
                  看业务全景
                </Link>
              }
            />
          )}
          {pending.map((item) => (
            <article
              key={item.id}
              className="rounded-lg border border-dashed border-line bg-surface px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{KIND_LABEL[item.kind] ?? item.kind}</Badge>
                    <h3 className="truncate text-sm font-medium text-ink-900">{item.title}</h3>
                  </div>
                  <p className="mt-1 text-sm text-ink-400">{item.summary}</p>
                </div>
                <MoneyText
                  money={
                    item.amountCents !== null && item.currency
                      ? { amount: item.amountCents, currency: item.currency }
                      : null
                  }
                />
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-xs text-ink-400">{relativeTime(item.createdAt)}</span>
                <div className="flex gap-2">
                  <Link
                    href={`/approvals?id=${item.id}&kind=${item.kind}`}
                    className="inline-flex min-h-9 items-center rounded-md border border-line px-3 text-sm text-ink-700 hover:border-ink-400"
                  >
                    看详情
                  </Link>
                  <Button
                    variant="primary"
                    className="min-h-9"
                    disabled={decide.isPending}
                    onClick={() => void approve(item.id, item.kind)}
                  >
                    批准
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="grid content-start gap-3">
          <h2 className="text-sm font-medium text-ink-700">正在进行</h2>
          <AgentRunStrip
            runs={runs}
            empty={<p className="text-sm text-ink-400">今天没有智能体动态。</p>}
          />

          <h2 className="mt-2 text-sm font-medium text-ink-700">出事了</h2>
          <div
            className={cn(
              "rounded-lg border px-4 py-3 text-sm",
              (stats?.rejectedCount ?? 0) > 0
                ? "border-vermilion-600/40 bg-vermilion-600/10 text-vermilion-600"
                : "border-line bg-surface text-ink-400",
            )}
          >
            {(stats?.rejectedCount ?? 0) > 0
              ? `${stats?.rejectedCount} 张单据被驳回，点审批窗口查看原因。`
              : "没有异常。交期、收款、寄样跟进都在正常范围。"}
          </div>
        </section>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium text-ink-700">说点什么</h2>
        <IntentComposer
          onSubmit={(text) => {
            setIntents((current) => [text, ...current].slice(0, 3));
            setNotice("已收到，小织正在拆解这条需求，草稿会出现在审批窗口。");
          }}
        />
      </section>
    </div>
  );
}
