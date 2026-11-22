"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useApprovals,
  useDecideApproval,
  useDemoScene,
  useIntentChannel,
  useOnboardingState,
  usePanorama,
  useShippingPending,
} from "@weave-order/core";
import {
  Badge,
  Button,
  EmptyState,
  IntentComposer,
  IntentRunCard,
  MoneyText,
  Spinner,
  cn,
} from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { KIND_LABEL, relativeTime } from "@/format";
import { todayHeadline } from "@/today-copy";
import { OnboardingChecklist } from "@/onboarding-checklist";
import {
  onboardingIntentContext,
  onboardingQuoteContextFrom,
  onboardingSteps,
  stepsToRecord,
} from "@/onboarding";
import { useProductionLike } from "@/runtime-mode.client";

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
  // 页内 composer 与顶栏 ⌘K 共用同一个 hook；这里只负责选择 source 与展示位置。
  const intentChannel = useIntentChannel(api);
  // 演示剧本深链只属于演示环境：生产态连请求都不发，避免每条访问打一次 404。
  const productionLike = useProductionLike();
  /*
   * 用 `useSearchParams()` 而不是在 `useState` 初始化器里读 `window.location`：
   * 开张清单第③步、客户 360 的快捷动作都是**同路由软导航**（只改 query），
   * App Router 不会重新挂载页面，初始化器不会再跑 —— 于是 `intent` 取到空值、
   * 提交也不带 context（WAN-142 R1）。`(desktop)` 布局是 force-dynamic，
   * 这里用 searchParams 不会触发静态预渲染的 Suspense 限制。
   */
  const searchParams = useSearchParams();
  const router = useRouter();
  // 演示剧本深链：`/today?scene=approval-pending`。
  const sceneKey = searchParams.get("scene");
  const scene = useDemoScene(api, productionLike ? null : sceneKey);
  // 客户 360 的「新建报价 / 建寄样单」把它带到意图栏，客户名不用重打。
  const initialIntent = searchParams.get("intent") ?? undefined;
  // 空状态「新建事项」只打开输入位置：不预填指导语，但要把光标放进去。
  const autoFocusComposer = searchParams.get("compose") === "1";
  // 开张清单第③步：这次输入带着刚建的客户 + 样品，提交时随意图一起落库。
  const onboardingQuote = searchParams.get("onboard") === "quote";
  const pending = approvals.data?.items ?? [];
  const stats = panorama.data?.stats;
  const loading = panorama.isLoading || approvals.isLoading;
  // 动态流是后端投影好的业务事件：actorLabel / summary / eventKind 都由 API 给定。
  const events = panorama.data?.events ?? [];
  const running = events.filter((event) => event.eventKind === "AGENT_RUNNING");
  const finished = events.filter((event) => event.eventKind !== "AGENT_RUNNING");
  const agentDone = stats?.todayAgentDoneCount ?? 0;
  const customerCount = stats?.customerCount ?? 0;
  const sampleCount = stats?.sampleCount ?? 0;
  const newWorkspace = customerCount === 0 && sampleCount === 0;

  // 开张清单：完成判定只看服务端统计；首次完成时间与收起/跳过存在后端，换设备一致。
  const {
    state: onboardingSaved,
    update: saveOnboarding,
    updating: onboardingSaving,
    saveError: onboardingSaveError,
  } = useOnboardingState(api);
  const quoteContext = useMemo(
    () =>
      onboardingQuoteContextFrom(
        panorama.data
          ? { customers: panorama.data.customers, samples: panorama.data.samples }
          : undefined,
      ),
    [panorama.data],
  );
  const onboarding = useMemo(
    () =>
      onboardingSteps(
        {
          customerCount,
          sampleCount,
          quoteCount: stats?.quoteCount ?? 0,
          sentQuoteCount: stats?.sentQuoteCount ?? 0,
          confirmedShipmentCount: stats?.confirmedShipmentCount ?? 0,
        },
        quoteContext,
      ),
    [
      customerCount,
      sampleCount,
      stats?.quoteCount,
      stats?.sentQuoteCount,
      stats?.confirmedShipmentCount,
      quoteContext,
    ],
  );

  // 业务上已经完成、进度表还没有首次时间的步骤：上报一次，时间由服务端给。
  const recordSteps = useCallback(
    async (keys: ReturnType<typeof stepsToRecord>) => {
      if (keys.length === 0) return;
      try {
        await saveOnboarding({ completeSteps: keys });
      } catch {
        // 错误由 onboardingSaveError 在清单里就地展示，不吞掉也不假装成功。
      }
    },
    [saveOnboarding],
  );

  useEffect(() => {
    if (loading || !onboardingSaved || onboardingSaving) return;
    void recordSteps(stepsToRecord(onboarding, onboardingSaved));
  }, [loading, onboarding, onboardingSaved, onboardingSaving, recordSteps]);

  const handleCollapse = useCallback(
    (collapsed: boolean) => {
      void saveOnboarding({ collapsed }).catch(() => {
        // 同上：失败由 saveError 显示。
      });
    },
    [saveOnboarding],
  );

  const handleSkip = useCallback(() => {
    void saveOnboarding({ skipped: true, collapsed: true }).catch(() => {});
  }, [saveOnboarding]);

  // 第③步带过来的客户 + 样品：作为意图 context 一起落库，用户只补数量与价格。
  const intentContext = onboardingQuote
    ? onboardingIntentContext(
        panorama.data
          ? { customers: panorama.data.customers, samples: panorama.data.samples }
          : undefined,
      )
    : undefined;

  const headline = todayHeadline({
    agentDone,
    pendingCount: pending.length,
    isNewWorkspace: newWorkspace,
  });

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

  return (
    <div className="grid gap-6">
      {!loading && onboardingSaved && (
        <OnboardingChecklist
          steps={onboarding}
          state={onboardingSaved}
          onCollapse={handleCollapse}
          onSkip={handleSkip}
          saveError={
            onboardingSaveError instanceof Error
              ? onboardingSaveError.message
              : onboardingSaveError
                ? "网络或服务暂时不可用"
                : null
          }
          autoCollapse={customerCount > 0 || sampleCount > 0}
        />
      )}
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
                {headline}
                {pending.length > 0 && (
                  <span className="text-vermilion-600">，{pending.length} 件等你决定</span>
                )}
              </h1>
            )}
            <p className="mt-1 text-sm text-ink-400">
              小织做好的都列在下面，点开就能看依据、做决定。
            </p>
          </div>
          <div className="flex gap-2">
            {stats && !newWorkspace && (
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
              title="今天没有要你决定的事"
              description={
                customerCount > 0
                  ? `${customerCount} 个客户在跟；新的草稿会出现在这里。`
                  : "有了客户和样品，小织就能开始报价。新的草稿会出现在这里。"
              }
              actions={
                <>
                  <Link
                    href="/panorama/customers"
                    className="inline-flex min-h-9 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
                  >
                    去建客户
                  </Link>
                  <Link
                    href="/panorama"
                    className="inline-flex min-h-9 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
                  >
                    看业务全景
                  </Link>
                </>
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
          <h2 className="text-sm font-medium text-ink-700">正在进行</h2>
          {running.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line bg-surface px-4 py-3 text-sm text-ink-400">
              小织还没接到活。
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
              {running.map((event) => (
                <li key={event.id} className="flex items-start gap-3 px-4 py-3">
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-indigo-600 animate-pulse"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm text-ink-900">
                      <span className="font-medium">{event.actorLabel}</span>
                      <span className="text-ink-700">{event.summary}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-400">
                      {relativeTime(event.createdAt)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-400">进行中</span>
                </li>
              ))}
            </ul>
          )}

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
              : "还没有可监控的单据。建第一张订单后，交期和收款会在这里盯。"}
          </div>
        </section>
      </div>

      <section className="grid gap-3">
        <h2 className="text-sm font-medium text-ink-700">最近的动态</h2>
        {finished.length === 0 ? (
          <EmptyState
            title={newWorkspace ? "小织还没开始干活" : "小织今天还没有新产出"}
            description={
              newWorkspace
                ? "建好第一个客户和样品，或者对它说一句话，这里就会出现它的进展。"
                : "说一句话，或者从客户 360 派一单，进展会出现在这里。"
            }
            actions={
              <>
                <Link
                  href="/panorama/customers"
                  className="inline-flex min-h-9 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
                >
                  去建客户
                </Link>
                <a
                  href="#intent"
                  className="inline-flex min-h-9 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
                >
                  说点什么
                </a>
              </>
            }
          />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {finished.slice(0, 12).map((event) => {
              const href =
                event.entityType === "customer" ? `/panorama/customers/${event.entityId}` : null;
              const body = (
                <>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-ink-900">
                    <span className="font-medium">{event.actorLabel}</span>
                    <span className="text-ink-700">{event.summary}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-400">
                    {relativeTime(event.createdAt)}
                  </span>
                </>
              );
              return (
                <li key={event.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  {href ? (
                    <Link href={href} className="min-w-0 flex-1 hover:underline">
                      {body}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1">{body}</span>
                  )}
                  <span className="shrink-0 text-xs text-ink-400">
                    {event.eventKind === "MILESTONE"
                      ? "里程碑"
                      : event.actorType === "AGENT"
                        ? "自主完成"
                        : "人工完成"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section id="intent">
        <h2 className="mb-2 text-sm font-medium text-ink-700">说点什么</h2>
        {onboardingQuote && (
          <p className="mb-2 rounded-md border border-indigo-600/25 bg-indigo-600/5 px-3 py-2 text-xs text-ink-700">
            {intentContext
              ? `已带上客户 ${intentContext.customerName ?? ""}${
                  intentContext.sampleCode ? ` · 样品 ${intentContext.sampleCode}` : ""
                }，只补数量和价格。`
              : "先在客户/样品页建好一个，这里提交时就会自动带上。"}
          </p>
        )}
        <IntentComposer
          initialText={initialIntent}
          autoFocus={autoFocusComposer}
          submitLabel="下一步：补充并确认"
          submittingLabel="正在打开…"
          submittingHint="正在打开统一输入页，原话会带过去，不会丢。"
          hint="点「下一步」会打开统一输入页：可以补充图片/附件、确认理解，再发给小织。"
          busy={intentChannel.submitting}
          error={intentChannel.submitError}
          onSubmit={(text) => {
            // 统一输入：页内 composer 不再直接提交，原话与上下文一起带到 /inbound。
            // 按钮与提示已明确写成两步，避免用户误以为这一下已经发给小织。
            const params = new URLSearchParams({ text });
            for (const [key, value] of Object.entries(intentContext ?? {})) {
              params.set(key, String(value));
            }
            router.push(`/inbound?${params.toString()}`);
            return Promise.resolve(true);
          }}
        />
        {(intentChannel.items.length > 0 || intentChannel.submitError) && (
          <div className="mt-3 grid gap-2">
            <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-400">
              这句话的去向
            </h3>
            {intentChannel.items.slice(0, 5).map((intent) => (
              <IntentRunCard
                key={intent.id}
                intent={intent}
                busy={intentChannel.submitting}
                onCancel={(id) => void intentChannel.cancel(id)}
                onRetry={(item) => void intentChannel.retry(item)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
