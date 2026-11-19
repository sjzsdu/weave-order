"use client";

import Link from "next/link";
import { useState } from "react";
import { usePanorama } from "@weave-order/core";
import {
  AuditTrail,
  Badge,
  Button,
  EmptyState,
  MoneyText,
  SampleTile,
  Spinner,
  cn,
} from "@weave-order/ui";
import { useApi } from "@/providers";
import { Can } from "@/can";
import { useMounted } from "@/use-mounted";
import { SharePanel } from "@/share-panel";
import { useFieldOptions } from "@/field-options-manager";
import { actionLabel, KIND_LABEL, relativeTime, STATUS_LABEL, TIER_LABEL } from "@/format";

const STAT_KEYS = [
  { key: "customerCount", label: "客户" },
  { key: "sampleCount", label: "样品" },
  { key: "quoteCount", label: "报价" },
  { key: "pendingCount", label: "待批草稿" },
  { key: "sentQuoteCount", label: "已发报价" },
  { key: "confirmedShipmentCount", label: "已确认寄样" },
] as const;

/** 业务全景：一次只读聚合，页面不提供任何写操作。 */
export default function PanoramaPage() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <PanoramaPageContent />;
}

function PanoramaPageContent() {
  // 自定义等级也要显示名字：接口失败时回退 static 预置表。
  const { options: tierOptions } = useFieldOptions("customer.tier");
  const tierLabel = (code: string) =>
    tierOptions.find((option) => option.code === code)?.label ?? TIER_LABEL[code] ?? code;
  const api = useApi();
  const panorama = usePanorama(api);
  const [shareTarget, setShareTarget] = useState<{ id: string; title: string } | null>(null);

  if (panorama.isLoading) return <Spinner label="正在汇总业务全景…" />;
  if (panorama.isError || !panorama.data) {
    return (
      <EmptyState
        title="全景暂时不可用"
        description={panorama.error instanceof Error ? panorama.error.message : "请稍后重试"}
      />
    );
  }

  const data = panorama.data;

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-indigo-600">业务全景</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">全局一眼看完</h1>
          <p className="mt-1 text-sm text-ink-400">
            生成于 {new Date(data.generatedAt).toLocaleString("zh-CN")}
          </p>
        </div>
        {/* 全景里能新建样品、能从客户 360 发起报价，所以不再声明「只读」。
            常驻操作条让「建客户 / 建样品」在任何时候都点得到，而不是翻三级菜单。 */}
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/panorama/customers?new=1"
            className="inline-flex min-h-9 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
          >
            建客户
          </Link>
          <Link
            href="/panorama/samples?new=1"
            className="inline-flex min-h-9 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
          >
            建样品
          </Link>
        </div>
      </header>

      <section className="grid gap-3 md:grid-cols-2">
        {/* 财务的默认工作面是应收：订单不在一级入口出现。能力表 `panorama.orders.view`。 */}
        <Can cap="panorama.orders.view">
          <Link
            href="/panorama/orders"
            className="rounded-lg border border-line bg-surface px-4 py-4 hover:border-indigo-600"
          >
            <div className="text-xs uppercase tracking-[0.18em] text-indigo-600">报价与订单</div>
            <div className="mt-1 text-base font-semibold text-ink-900">按交期看订单漏斗</div>
            <p className="mt-1 text-sm text-ink-400">
              逾期的排最前，点开就是那张单，从草稿到发货一路看得见。
            </p>
          </Link>
        </Can>
        <Link
          href="/panorama/receivables"
          className="rounded-lg border border-line bg-surface px-4 py-4 hover:border-indigo-600"
        >
          <div className="text-xs uppercase tracking-[0.18em] text-indigo-600">应收与对账</div>
          <div className="mt-1 text-base font-semibold text-ink-900">逾期、本月到期、已结清</div>
          <p className="mt-1 text-sm text-ink-400">
            登记回款后余额与分组立即刷新；对账单能点开看到每笔订单与每笔回款。
          </p>
        </Link>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {STAT_KEYS.map((stat) => (
          <StatCard
            key={stat.key}
            label={stat.label}
            value={data.stats[stat.key]}
            highlight={stat.key === "pendingCount" && data.stats.pendingCount > 0}
            href={stat.key === "sampleCount" ? "/panorama/samples" : undefined}
          />
        ))}
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="grid content-start gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-ink-700">客户</h2>
            <Link
              href="/panorama/customers"
              className="text-xs text-indigo-600 underline underline-offset-2"
            >
              客户列表与 360 →
            </Link>
          </div>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <table className="w-full text-sm">
              <thead className="bg-paper text-xs text-ink-400">
                <tr>
                  <th className="px-3 py-2 text-left font-normal">客户</th>
                  <th className="px-3 py-2 text-left font-normal">等级</th>
                  <th className="px-3 py-2 text-left font-normal">联系人</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.customers.map((customer) => (
                  <tr key={customer.id}>
                    <td className="px-3 py-2">
                      <Link
                        href={`/panorama/customers/${customer.id}`}
                        className="text-ink-900 underline-offset-2 hover:underline"
                      >
                        {customer.name}
                      </Link>
                      <div className="text-xs text-ink-400">{customer.code}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={customer.tier === "VIP" ? "info" : "neutral"}>
                        {tierLabel(customer.tier)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-ink-700">
                      {customer.contactName ?? "—"}
                      {customer.contactPhone && (
                        <span className="block text-xs text-ink-400">{customer.contactPhone}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid content-start gap-3">
          <h2 className="text-sm font-medium text-ink-700">样品</h2>
          <div className="grid gap-2">
            {data.samples.slice(0, 6).map((sample) => (
              <SampleTile key={sample.id} sample={sample} />
            ))}
            {data.samples.length === 0 && (
              <EmptyState
                title="还没有样品"
                description="手动建一个，或导入 CSV（可先下载模板）。"
                actions={
                  <>
                    <Link
                      href="/panorama/samples?new=1"
                      className="inline-flex min-h-9 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700"
                    >
                      新建样品
                    </Link>
                    <Link
                      href="/panorama/samples?import=1"
                      className="inline-flex min-h-9 items-center rounded-md border border-line px-4 text-sm text-ink-700 hover:border-ink-400"
                    >
                      导入 CSV
                    </Link>
                  </>
                }
              />
            )}
          </div>
        </section>
      </div>

      <section className="grid content-start gap-3">
        <h2 className="text-sm font-medium text-ink-700">单据</h2>
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-paper text-xs text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-normal">类型</th>
                <th className="px-3 py-2 text-left font-normal">单据</th>
                <th className="px-3 py-2 text-left font-normal">状态</th>
                <th className="px-3 py-2 text-right font-normal">金额</th>
                <th className="px-3 py-2 text-right font-normal">时间</th>
                <th className="px-3 py-2 text-right font-normal">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((item) => (
                <tr key={`${item.kind}-${item.id}`}>
                  <td className="px-3 py-2">
                    <Badge tone="neutral">{KIND_LABEL[item.kind] ?? item.kind}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-ink-900">{item.title}</div>
                    <div className="text-xs text-ink-400">{item.summary}</div>
                  </td>
                  <td className="px-3 py-2 text-ink-700">
                    {STATUS_LABEL[item.status] ?? item.status}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <MoneyText
                      money={
                        item.amountCents !== null && item.currency
                          ? { amount: item.amountCents, currency: item.currency }
                          : null
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-ink-400">
                    {relativeTime(item.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {item.kind === "quote" && item.status === "SENT" ? (
                      <Button
                        variant="secondary"
                        className="min-h-9 px-3 text-xs"
                        onClick={() => setShareTarget({ id: item.id, title: item.title })}
                      >
                        分享 / 访问数据
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid content-start gap-3">
        <h2 className="text-sm font-medium text-ink-700">最近审计（只追加）</h2>
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <AuditTrail entries={data.audit} limit={10} />
          <p className="mt-3 border-t border-line pt-2 text-xs text-ink-400">
            最近动作：{data.audit[0] ? actionLabel(data.audit[0].action) : "暂无"}
          </p>
        </div>
      </section>

      {shareTarget && (
        <SharePanel
          quoteId={shareTarget.id}
          title={shareTarget.title}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}

/** 全景的统计卡；「样品」可点进图墙，其余保持只读展示。 */
function StatCard({
  label,
  value,
  highlight,
  href,
}: {
  label: string;
  value: number;
  highlight?: boolean;
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between text-xs text-ink-400">
        <span>{label}</span>
        {href && <span className="text-indigo-600">图墙 →</span>}
      </div>
      <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-ink-900">{value}</div>
    </>
  );
  const className = cn(
    "block rounded-lg border bg-surface px-4 py-3",
    highlight ? "border-amber-600/50" : "border-line",
    href && "transition-colors hover:border-indigo-600",
  );
  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}
