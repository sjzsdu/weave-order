"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  useApprovals,
  useCustomerList,
  useDecideApproval,
  useDemoScene,
  usePanorama,
  useRunQuoteAgent,
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
import type { QuoteAgentResult } from "@weave-order/schema";

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
  const [error, setError] = useState<string | null>(null);
  const [agentResult, setAgentResult] = useState<QuoteAgentResult | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [customerId, setCustomerId] = useState("");
  const customers = useCustomerList(api, { limit: 100, owner: "all" });
  const runAgent = useRunQuoteAgent(api);
  // 演示剧本深链：`/today?scene=approval-pending`。生产环境接口 404，这里只是静默失败。
  const [sceneKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("scene");
  });
  const scene = useDemoScene(api, sceneKey);
  // 客户 360 的「新建报价 / 建寄样单」把它带到意图栏，客户名不用重打。
  const [initialIntent] = useState(() => {
    if (typeof window === "undefined") return undefined;
    return new URLSearchParams(window.location.search).get("intent") ?? undefined;
  });
  // 顶栏 ⌘K 提交后带着原话跳到这里并自动执行一次；不再把输入直接丢掉。
  const [autoSubmitIntent] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("submit") === "1";
  });

  const runs = useMemo<AgentRun[]>(() => {
    return (panorama.data?.events ?? []).map((event) => ({
      id: event.id,
      agent: event.actorLabel,
      what: actionLabel(event.action),
      status: "done" as const,
      hint: `${event.kind === "AGENT_DONE" ? "自主完成" : "人工操作"} · ${relativeTime(event.createdAt)}`,
    }));
  }, [panorama.data]);

  const pending = approvals.data?.items ?? [];
  const stats = panorama.data?.stats;
  const loading = panorama.isLoading || approvals.isLoading;
  const isBrandNew = (stats?.customerCount ?? 0) === 0 && (stats?.sampleCount ?? 0) === 0;
  const agentDoneToday = stats?.todayAgentDoneCount ?? 0;

  useEffect(() => {
    if (!scene.data?.entityId) return;
    // 剧本解析到真实 id 后滚到高亮卡片；找不到就保持页面原位，不打断演示。
    document
      .querySelector('[data-scene-highlight="true"]')
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scene.data?.entityId]);

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

  /**
   * 真实意图提交：只有 agent 明确回 `DRAFTED` 才算成功。失败与缺字段都
   * 原样展示，并保留输入内容供重试 —— 不再有「绿色假成功」。
   */
  async function submitIntent(text: string) {
    setAgentResult(null);
    setAgentError(null);
    try {
      const result = await runAgent.mutateAsync({
        rawText: text,
        ...(customerId ? { customerId } : {}),
      });
      setAgentResult(result);
      if (result.status !== "FAILED") setResetToken((value) => value + 1);
    } catch (cause) {
      const aborted =
        cause instanceof DOMException &&
        (cause.name === "TimeoutError" || cause.name === "AbortError");
      setAgentError(
        aborted
          ? "小织超过 2 分钟没回来，这次没整理出来；原话还在输入框里，可以直接再试一次。"
          : cause instanceof Error
            ? cause.message
            : "提交失败，请稍后重试",
      );
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
                {agentDoneToday > 0 ? (
                  <>
                    今天，小织替你做了 {agentDoneToday} 件事，
                    <span className={pending.length > 0 ? "text-vermilion-600" : "text-moss-600"}>
                      {" "}
                      {pending.length} 件等你决定
                    </span>
                  </>
                ) : isBrandNew ? (
                  <>欢迎，先把客户和样品放进来</>
                ) : (
                  <>
                    今天还没有新的智能体动态，
                    <span className={pending.length > 0 ? "text-vermilion-600" : "text-moss-600"}>
                      {" "}
                      {pending.length} 件等你决定
                    </span>
                  </>
                )}
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
        {scene.data && (
          <div
            data-demo-scene={scene.data.key}
            className="mt-3 rounded-md border border-indigo-600/30 bg-indigo-600/5 px-3 py-2 text-sm text-ink-700"
          >
            <span className="font-medium">{scene.data.title}</span>
            <span className="ml-2 text-ink-400">{scene.data.description}</span>
            {!scene.data.resolved && (
              <span className="ml-2 text-vermilion-600">
                剧本单据不在当前库，先运行 <code>pnpm demo:reset</code>。
              </span>
            )}
          </div>
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
              description={
                (stats?.customerCount ?? 0) > 0
                  ? `${stats?.customerCount} 个客户在跟；新的草稿会出现在这里。`
                  : "还没有客户。建一个客户，小织才能开始报价。"
              }
              actions={
                (stats?.customerCount ?? 0) > 0 ? (
                  <Link
                    href="/panorama"
                    className="text-sm text-indigo-600 underline underline-offset-2"
                  >
                    看业务全景
                  </Link>
                ) : (
                  <Link
                    href="/panorama/customers"
                    className="text-sm text-indigo-600 underline underline-offset-2"
                  >
                    去建第一个客户 →
                  </Link>
                )
              }
            />
          )}
          {pending.map((item) => {
            const highlighted =
              scene.data?.highlight === "approval" && scene.data.entityId === item.id;
            return (
              <article
                key={item.id}
                data-scene-highlight={highlighted ? "true" : undefined}
                className={cn(
                  "rounded-lg border border-dashed border-line bg-surface px-4 py-3",
                  highlighted && "border-indigo-600 bg-indigo-600/5 ring-2 ring-indigo-600/20",
                )}
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
            );
          })}
        </section>

        <section className="grid content-start gap-3">
          <h2 className="text-sm font-medium text-ink-700">今天发生的事</h2>
          <AgentRunStrip
            runs={runs}
            empty={
              <p className="text-sm text-ink-400">
                小织还没接到活。先把客户和样品放进来，或者下面说一句话。
              </p>
            }
          />

          <h2 className="mt-2 text-sm font-medium text-ink-700">需要留意</h2>
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
              : (stats?.quoteCount ?? 0) + (stats?.shipmentCount ?? 0) === 0
                ? "还没有可监控的单据。建第一张订单后，交期和收款会在这里盯。"
                : "暂时没有需要留意的异常。"}
          </div>
        </section>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium text-ink-700">说点什么</h2>
        <IntentComposer
          initialText={initialIntent}
          autoSubmit={autoSubmitIntent}
          busy={runAgent.isPending}
          error={agentError}
          resetToken={resetToken}
          onSubmit={(text) => void submitIntent(text)}
          contextSlot={
            <label className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
              报价给
              <select
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
                className="min-h-9 min-w-48 rounded-md border border-line bg-surface px-2 text-sm"
              >
                <option value="">先不选（小织会告诉你还缺客户）</option>
                {(customers.data ?? []).map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </label>
          }
        />
        {runAgent.isPending && (
          <p className="mt-3 text-sm text-ink-400" aria-live="polite">
            小织正在读你贴的原话、找样、算价，通常会等十几秒。
          </p>
        )}
        {agentResult && <IntentResultCard result={agentResult} />}
      </section>
    </div>
  );
}

/**
 * 意图回执卡：三种真实结局各自可见。
 * DRAFTED 指到审批窗口，NEEDS_INPUT 列出缺什么，FAILED 给出原因与重试入口
 * （重试由用户再点一次「生成草稿」，原文仍在输入框里）。
 */
function IntentResultCard({ result }: { result: QuoteAgentResult }) {
  if (result.status === "DRAFTED" && result.draft) {
    return (
      <div className="mt-3 rounded-lg border border-moss-600/40 bg-moss-600/10 px-4 py-3 text-sm text-ink-700">
        <p className="font-medium text-moss-600">草稿已生成，等你决定。</p>
        <p className="mt-1">{result.explanation}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-ink-400">
            合计 <MoneyText money={result.draft.total} />
          </span>
          <Link
            href={`/approvals?id=${result.draft.id}&kind=quote`}
            className="text-indigo-600 underline underline-offset-2"
          >
            去看这份草稿 →
          </Link>
        </div>
      </div>
    );
  }
  if (result.status === "NEEDS_INPUT") {
    return (
      <div className="mt-3 rounded-lg border border-amber-600/40 bg-amber-100 px-4 py-3 text-sm text-ink-700">
        <p className="font-medium">小织还缺这些信息，补齐后才能出草稿：</p>
        <ul className="mt-2 list-inside list-disc text-ink-700">
          {result.missingFields.map((field) => (
            <li key={field.code}>
              {field.label}：{field.prompt}
            </li>
          ))}
        </ul>
        {result.explanation && <p className="mt-2 text-ink-400">{result.explanation}</p>}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-vermilion-600/40 bg-vermilion-600/10 px-4 py-3 text-sm text-vermilion-600">
      <p className="font-medium">小织这次没整理出来。</p>
      <p className="mt-1">{result.failure?.message ?? result.explanation}</p>
      <p className="mt-1 text-ink-400">原话还在输入框里，改一改再提交一次即可。</p>
    </div>
  );
}
