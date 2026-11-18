"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuthContext, useCustomer360, useCustomerTimeline } from "@weave-order/core";
import { ApiError } from "@weave-order/core";
import type { CustomerTimelineEvent, CustomerTimelineKind } from "@weave-order/schema";
import { Badge, Button, CustomerHeader, EmptyState, MoneyText, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { SharePanel } from "@/share-panel";
import { InboundReplyDrawer } from "@/inbound-reply-drawer";
import { STATUS_LABEL, TIMELINE_KIND_LABEL, actionLabel, ownerLabel, relativeTime } from "@/format";

type TimelineFilter = "all" | CustomerTimelineKind;

const TIMELINE_FILTERS: Array<{ value: TimelineFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "quote", label: "报价" },
  { value: "sample_shipment", label: "寄样" },
  { value: "order", label: "订单" },
  { value: "receivable", label: "回款" },
  { value: "followup", label: "跟进" },
  { value: "inbound_reply", label: "客户回复" },
];

const SENSITIVITY_LABEL: Record<string, string> = {
  HIGH: "高敏感",
  MEDIUM: "中等",
  LOW: "不敏感",
};

const CHANNEL_LABEL: Record<string, string> = {
  WECHAT: "微信",
  WECHAT_WORK: "企业微信",
  EMAIL: "邮件",
  PHONE: "电话",
};

const TERMS_LABEL: Record<string, string> = {
  TT_ADVANCE: "款到发货",
  TT_30D: "月结 30 天",
  TT_60D: "月结 60 天",
  LC: "信用证",
  DP: "付款交单",
};

const WEEKDAY_LABEL: Record<string, string> = {
  MONDAY: "周一",
  TUESDAY: "周二",
  WEDNESDAY: "周三",
  THURSDAY: "周四",
  FRIDAY: "周五",
  SATURDAY: "周六",
  SUNDAY: "周日",
};

/**
 * 订单详情页的归属：WAN-120（PR #63）在 `/panorama/orders/:orderId` 新建，
 * 本 PR 不重复建一套。它合入前，订单 / 回款先复用现有发货页（同一个订单 id，
 * 行项目与发货记录都在）；WAN-120 落地后只改这一行即可。回款也指向所属订单。
 */
function orderDetailHref(orderId: string): string {
  return `/shipping/${encodeURIComponent(orderId)}`;
}

/** 时间线条目点开去哪张源单据。跟进来没有独立页面，返回 null。 */
function sourceHref(event: CustomerTimelineEvent): string | null {
  if (event.kind === "quote") {
    return `/approvals?id=${encodeURIComponent(event.sourceId)}&kind=quote`;
  }
  if (event.kind === "sample_shipment") {
    return `/approvals?id=${encodeURIComponent(event.sourceId)}&kind=sample_shipment`;
  }
  if (event.kind === "order" || event.kind === "receivable") {
    return orderDetailHref(event.sourceId);
  }
  return null;
}

function shortId(value: string | null): string {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function eventTitle(event: CustomerTimelineEvent): string {
  if (event.kind === "order") return `订单 · ${event.code ?? shortId(event.refId)}`;
  if (event.kind === "followup") return actionLabel(event.code ?? "");
  if (event.kind === "inbound_reply") {
    const source = event.code === "screenshot" ? "截图 OCR" : "文本粘贴";
    return `客户回复 · ${source}`;
  }
  return `${TIMELINE_KIND_LABEL[event.kind] ?? event.kind} · ${shortId(event.refId)}`;
}

function statusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "DRAFT" || status === "PENDING") return "warning";
  if (status === "CONFIRMED" || status === "SENT" || status === "IN_PRODUCTION") return "info";
  if (status === "PAID" || status === "COMPLETED" || status === "DELIVERED") return "success";
  if (status === "OVERDUE" || status === "REJECTED" || status === "CANCELLED") return "danger";
  return "neutral";
}

/**
 * 客户 360：概览 / 时间线 / 未决事项 / 快捷动作。
 *
 * 所有数字来自后端聚合（与列表同一口径）；点数字 = 把时间线收敛到该类型，
 * 每条时间线再点开就是源单据。前端不计算金额、不推导状态。
 */
export function Customer360Panel({
  customerId,
  onClose,
  embedded = false,
}: {
  customerId: string;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const api = useApi();
  const me = useAuthContext(api);
  const myMembershipId = me.data && !("tenants" in me.data) ? me.data.membership.id : null;
  const detail = useCustomer360(api, customerId);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [shareTarget, setShareTarget] = useState<{ id: string; title: string } | null>(null);
  const [inboundOpen, setInboundOpen] = useState(false);

  const kinds: CustomerTimelineKind[] = filter === "all" ? [] : [filter];
  const timeline = useCustomerTimeline(api, customerId, kinds);

  // 抽屉可以用 Esc 关掉，键盘用户不用去够右上角。
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (detail.isLoading) {
    return (
      <div className="p-6">
        <Spinner label="正在读取客户 360…" />
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="grid gap-4 p-6">
        {onClose && (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
        )}
        <EmptyState
          title={notFound ? "客户不存在或不在你的数据范围内" : "客户 360 暂时不可用"}
          description={
            notFound
              ? "可能已交接给其他同事，或链接已失效。"
              : detail.error instanceof Error
                ? detail.error.message
                : "请稍后重试"
          }
          actions={
            <Link
              href="/panorama/customers"
              className="text-sm text-indigo-600 underline underline-offset-2"
            >
              回客户列表
            </Link>
          }
        />
      </div>
    );
  }

  const data = detail.data;
  const summary = data.summary;
  const customer = data.customer;
  const context = data.context;

  // 分享按钮读汇总里的「最近一张已发报价」：既不受时间线筛选影响，
  // 也不会因为历史超过首屏 20 条而误判为「没有可分享的报价」。
  const shareableQuoteId = summary.latestShareableQuoteId;

  function focus(kind: CustomerTimelineKind) {
    setFilter((current) => (current === kind ? "all" : kind));
  }

  const quickIntent = encodeURIComponent(`给${customer.name}报价：`);

  return (
    <div className={cn("grid gap-5", embedded ? "" : "p-5")}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CustomerHeader
            customer={customer}
            meta={
              <p className="mt-1 text-xs text-ink-400">
                负责人 {ownerLabel(data.ownerName, data.ownerId, myMembershipId)} ·{" "}
                {summary.lastContactAt
                  ? `最近往来 ${relativeTime(summary.lastContactAt)}`
                  : "还没有往来记录"}
              </p>
            }
          />
        </div>
        <div className="flex items-center gap-2">
          {onClose && (
            <Button variant="ghost" onClick={onClose} aria-label="关闭客户 360">
              关闭
            </Button>
          )}
          <Link
            href={`/panorama/customers/${customer.id}`}
            className="text-xs text-ink-400 underline underline-offset-2"
          >
            独立页面
          </Link>
        </div>
      </header>

      <section aria-label="客户汇总" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <SummaryTile
          label="未决报价"
          value={String(summary.pendingQuoteCount)}
          hint="草稿待批"
          active={filter === "quote"}
          onClick={() => focus("quote")}
        />
        <SummaryTile
          label="在途寄样"
          value={String(summary.inTransitSampleCount)}
          hint="已确认未签收"
          active={filter === "sample_shipment"}
          onClick={() => focus("sample_shipment")}
        />
        <SummaryTile
          label="有效订单"
          value={String(summary.activeOrderCount)}
          hint="不含草稿/取消"
          active={filter === "order"}
          onClick={() => focus("order")}
        />
        <SummaryTile
          label="应收余额"
          value={
            summary.receivableBalance.length === 0 ? (
              "—"
            ) : (
              <span className="flex flex-col items-start gap-0.5">
                {summary.receivableBalance.map((money) => (
                  <MoneyText key={money.currency} money={money} size="sm" />
                ))}
              </span>
            )
          }
          hint="未收金额"
          active={filter === "receivable"}
          onClick={() => focus("receivable")}
        />
        <SummaryTile
          label="逾期应收"
          value={String(summary.overdueReceivableCount)}
          hint={summary.overdueReceivableCount > 0 ? "需要跟进" : "无逾期"}
          active={filter === "receivable"}
          tone={summary.overdueReceivableCount > 0 ? "danger" : "normal"}
          onClick={() => focus("receivable")}
        />
      </section>

      <section className="rounded-lg border border-line bg-surface px-4 py-3">
        <h2 className="text-sm font-medium text-ink-700">客户上下文</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <div className="text-xs text-ink-400">选样偏好</div>
            {context.preferenceNotes.length === 0 ? (
              <p className="mt-1 text-sm text-ink-400">还没有记录。</p>
            ) : (
              <ul className="mt-1 grid gap-1 text-sm text-ink-700">
                {context.preferenceNotes.map((note) => (
                  <li key={note}>· {note}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-2 text-sm text-ink-700">
            <ContextRow
              label="价格敏感度"
              value={
                SENSITIVITY_LABEL[context.pricingBehavior.sensitivity] ??
                context.pricingBehavior.sensitivity
              }
            />
            <ContextRow
              label="接受还价"
              value={
                context.pricingBehavior.counterofferAcceptanceRate === null
                  ? "未记录"
                  : `${Math.round(context.pricingBehavior.counterofferAcceptanceRate * 100)}%`
              }
            />
            <ContextRow
              label="付款方式"
              value={
                context.paymentPattern.preferredTerms
                  ? (TERMS_LABEL[context.paymentPattern.preferredTerms] ??
                    context.paymentPattern.preferredTerms)
                  : "未记录"
              }
            />
            <ContextRow
              label="准时付款"
              value={
                context.paymentPattern.onTimeRate === null
                  ? "未记录"
                  : `${Math.round(context.paymentPattern.onTimeRate * 100)}%`
              }
            />
            <ContextRow
              label="跟进偏好"
              value={
                [
                  context.followupPreference.preferredChannel
                    ? (CHANNEL_LABEL[context.followupPreference.preferredChannel] ??
                      context.followupPreference.preferredChannel)
                    : null,
                  context.followupPreference.preferredTimeWindow,
                  context.followupPreference.avoidDays.length > 0
                    ? `避开${context.followupPreference.avoidDays
                        .map((day) => WEEKDAY_LABEL[day] ?? day)
                        .join("、")}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "未记录"
              }
            />
          </div>
        </div>
        <p className="mt-3 border-t border-line pt-2 text-xs text-ink-400">
          这份客户资料由你和智能体一起补充，已有 {context.decisionDeltas.length} 条调整；更新于{" "}
          {relativeTime(context.updatedAt)}。
        </p>
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <Link href={`/today?intent=${quickIntent}&source=customer-360`}>
          <Button variant="primary" className="min-h-9 px-3 text-xs">
            新建报价
          </Button>
        </Link>
        <Link
          href={`/today?intent=${encodeURIComponent(`给${customer.name}寄样：`)}&source=customer-360`}
        >
          <Button className="min-h-9 px-3 text-xs">建寄样单</Button>
        </Link>
        <Button className="min-h-9 px-3 text-xs" onClick={() => setInboundOpen(true)}>
          录入客户回复
        </Button>
        <Button
          className="min-h-9 px-3 text-xs"
          disabled={!shareableQuoteId}
          title={shareableQuoteId ? undefined : "还没有已发出的报价可分享"}
          onClick={() =>
            shareableQuoteId &&
            setShareTarget({ id: shareableQuoteId, title: `报价 · ${customer.name}` })
          }
        >
          分享报价链接
        </Button>
        <span className="text-xs text-ink-400">确认与生效仍在审批窗口，这里只发起。</span>
      </section>

      <section className="grid content-start gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-ink-700">时间线</h2>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="时间线类型筛选">
            {TIMELINE_FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={cn(
                  "min-h-8 rounded-full border px-3 text-xs",
                  filter === item.value
                    ? "border-indigo-600 bg-indigo-100 text-indigo-600"
                    : "border-line text-ink-700 hover:border-ink-400",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {timeline.isLoading ? (
            <div className="px-4 py-6">
              <Spinner label="正在读取时间线…" />
            </div>
          ) : timeline.isError ? (
            <div className="px-4 py-6 text-sm text-vermilion-600">
              {timeline.error instanceof Error ? timeline.error.message : "时间线读取失败"}
            </div>
          ) : timeline.events.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-400">这个筛选下还没有记录，换个类型看看。</p>
          ) : (
            <ol className="divide-y divide-line">
              {timeline.events.map((event) => {
                const href = sourceHref(event);
                const body = (
                  <>
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone="neutral">{TIMELINE_KIND_LABEL[event.kind] ?? event.kind}</Badge>
                      <span className="truncate text-sm text-ink-900">{eventTitle(event)}</span>
                      {/* 跟进事件的 status 是审计动作名，标题已经说过了，不再重复一个徽标。 */}
                      {event.kind !== "followup" && (
                        <Badge tone={statusTone(event.status)}>
                          {STATUS_LABEL[event.status] ?? event.status}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <MoneyText money={event.amount} size="sm" muted={!event.amount} />
                      <span className="whitespace-nowrap text-xs text-ink-400">
                        {relativeTime(event.occurredAt)}
                      </span>
                      {href && (
                        <span aria-hidden className="text-xs text-ink-400">
                          ›
                        </span>
                      )}
                    </div>
                  </>
                );
                return (
                  <li key={event.id}>
                    {href ? (
                      <Link
                        href={href}
                        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-paper"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className="flex items-center justify-between gap-3 px-4 py-3">
                        {body}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {timeline.hasMore && (
          <div className="flex justify-center">
            <Button
              className="min-h-9 px-4 text-xs"
              disabled={timeline.isFetchingNextPage}
              onClick={() => void timeline.fetchNextPage()}
            >
              {timeline.isFetchingNextPage ? "正在加载…" : "加载更多"}
            </Button>
          </div>
        )}
        <p className="text-xs text-ink-400">
          时间线按时间倒序；数字与单据都点开到来源，首屏只取 20 条。
        </p>
      </section>

      {shareTarget && (
        <SharePanel
          quoteId={shareTarget.id}
          title={shareTarget.title}
          onClose={() => setShareTarget(null)}
        />
      )}

      <InboundReplyDrawer
        open={inboundOpen}
        customerId={customer.id}
        customerName={customer.name}
        onClose={() => setInboundOpen(false)}
        onDone={() => void timeline.refetch()}
      />
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  active,
  tone = "normal",
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint: string;
  active: boolean;
  tone?: "normal" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border px-4 py-3 text-left transition-colors",
        active
          ? "border-indigo-600/60 bg-indigo-100/40"
          : "border-line bg-surface hover:border-ink-400",
        tone === "danger" && "border-vermilion-600/40",
      )}
    >
      <div className="text-xs text-ink-400">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-2xl font-bold tabular-nums",
          tone === "danger" ? "text-vermilion-600" : "text-ink-900",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-ink-400">{hint}</div>
    </button>
  );
}

function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-ink-400">{label}</span>
      <span className="text-right text-ink-700">{value}</span>
    </div>
  );
}
