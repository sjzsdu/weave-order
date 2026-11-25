"use client";

import { useState } from "react";
import type { ApiClient } from "@weave-order/core";
import type { SampleShipmentRecord, SampleShipmentStatus } from "@weave-order/schema";
import { SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS } from "@weave-order/schema";
import { Badge } from "@weave-order/ui";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/**
 * 寄样状态的中文口径。
 * 文案只描述「这单走到哪」，不声称有人在跟——跟进状态目前没有落库。
 */
export const SHIPMENT_STATUS_LABEL: Record<SampleShipmentStatus, string> = {
  DRAFT: "草稿待确认",
  CONFIRMED: "已确认待发货",
  SHIPPED: "在途待签收",
  DELIVERED: "已签收待回复",
  CANCELLED: "已取消",
};

const STATUS_TONE: Record<SampleShipmentStatus, Tone> = {
  DRAFT: "neutral",
  CONFIRMED: "warning",
  SHIPPED: "info",
  DELIVERED: "success",
  CANCELLED: "neutral",
};

/**
 * 图墙卡片只显示一条寄样状态，优先级按「最需要人动手」排序：
 * 在途待签收 > 已签收待回复 > 已确认待发货 > 草稿待确认。
 * 已取消不上徽标——单子已作废，不该占据卡片的注意力。
 */
const BADGE_PRIORITY: Record<SampleShipmentStatus, number> = {
  SHIPPED: 4,
  DELIVERED: 3,
  CONFIRMED: 2,
  DRAFT: 1,
  CANCELLED: 0,
};

export function shipmentStatusLabel(status: SampleShipmentStatus): string {
  return SHIPMENT_STATUS_LABEL[status];
}

export function shipmentStatusTone(status: SampleShipmentStatus): Tone {
  return STATUS_TONE[status];
}

export interface SampleShipmentBadgeView {
  shipment: SampleShipmentRecord;
  label: string;
  tone: Tone;
}

/** 某样品最值得显示的一条寄样记录；没有（或只有已取消）时返回 null。 */
export function pickSampleShipmentBadge(
  shipments: readonly SampleShipmentRecord[],
  sampleId: string,
): SampleShipmentBadgeView | null {
  let best: { rank: number; shipment: SampleShipmentRecord } | null = null;
  for (const shipment of shipments) {
    if (!shipment.sampleIds.includes(sampleId)) continue;
    const rank = BADGE_PRIORITY[shipment.status];
    if (rank === 0) continue;
    if (
      !best ||
      rank > best.rank ||
      // 同优先级取最近一单；createdAt 相同再按 id 收敛，保证渲染稳定。
      (rank === best.rank &&
        (shipment.createdAt > best.shipment.createdAt ||
          (shipment.createdAt === best.shipment.createdAt && shipment.id > best.shipment.id)))
    ) {
      best = { rank, shipment };
    }
  }
  if (!best) return null;
  return {
    shipment: best.shipment,
    label: shipmentStatusLabel(best.shipment.status),
    tone: shipmentStatusTone(best.shipment.status),
  };
}

export interface SampleShipmentSummary {
  total: number;
  shipped: number;
  delivered: number;
  confirmed: number;
  draft: number;
}

/** 只统计未结束的寄样单；已取消不计入，避免把作废的单说成「在途」。 */
export function summarizeSampleShipments(
  shipments: readonly SampleShipmentRecord[],
): SampleShipmentSummary {
  const seen = new Set<string>();
  const summary: SampleShipmentSummary = {
    total: 0,
    shipped: 0,
    delivered: 0,
    confirmed: 0,
    draft: 0,
  };
  for (const shipment of shipments) {
    if (shipment.status === "CANCELLED" || seen.has(shipment.id)) continue;
    seen.add(shipment.id);
    summary.total += 1;
    if (shipment.status === "SHIPPED") summary.shipped += 1;
    else if (shipment.status === "DELIVERED") summary.delivered += 1;
    else if (shipment.status === "CONFIRMED") summary.confirmed += 1;
    else summary.draft += 1;
  }
  return summary;
}

/** 顶部汇总文案：数字全部来自寄样单状态，不替智能体邀功。 */
export function sampleShipmentSummaryText(summary: SampleShipmentSummary): string {
  if (summary.total === 0) return "当前图墙的样品没有未结的寄样单";
  const parts: string[] = [];
  if (summary.shipped > 0) parts.push(`${summary.shipped} 在途待签收`);
  if (summary.delivered > 0) parts.push(`${summary.delivered} 已签收待回复`);
  if (summary.confirmed > 0) parts.push(`${summary.confirmed} 已确认待发货`);
  if (summary.draft > 0) parts.push(`${summary.draft} 草稿待确认`);
  return `${summary.total} 个寄样单还没结束：${parts.join("，")}`;
}

/** 接口单次上限 100；图墙滚动加载久了会超过，按上限分片而不是逐样品请求。 */
export function chunkSampleIds(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS) {
    chunks.push(unique.slice(index, index + SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS));
  }
  return chunks;
}

/** 批量取寄样记录：跨分片的同一张单只保留一条。 */
export async function fetchSampleShipments(
  api: ApiClient,
  sampleIds: readonly string[],
): Promise<SampleShipmentRecord[]> {
  const chunks = chunkSampleIds(sampleIds);
  if (chunks.length === 0) return [];
  const pages = await Promise.all(
    chunks.map((chunk) => api.listSampleShipments({ sampleIds: chunk })),
  );
  const byId = new Map<string, SampleShipmentRecord>();
  for (const page of pages) {
    for (const shipment of page) byId.set(shipment.id, shipment);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function formatAt(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

function logisticsText(shipment: SampleShipmentRecord): string {
  const parts = [shipment.carrier, shipment.trackingNumber].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "未填运单";
}

/** 图墙卡片上的寄样徽标。没有记录时整块不渲染，不用「未寄样」占位。 */
export function SampleShipmentBadge({ view }: { view: SampleShipmentBadgeView }) {
  const { shipment } = view;
  return (
    <span
      className="mt-1 inline-flex"
      data-testid="sample-shipment-badge"
      title={`${shipment.customerName} · ${logisticsText(shipment)}`}
    >
      <Badge tone={view.tone}>{view.label}</Badge>
    </span>
  );
}

/** 复制运单号：失败时不弹错误，selection 仍可手选复制。 */
function CopyTracking({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-500 hover:border-ink-400 hover:text-ink-900"
      onClick={() => {
        const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
        if (!clipboard) return;
        void clipboard
          .writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
      aria-label={`复制运单号 ${value}`}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

/**
 * 样品抽屉里的寄样记录。
 *
 * 空态是一句事实陈述，不是「快去找小织」——这个样品没寄过就是没寄过。
 */
export function SampleShipmentHistory({
  shipments,
  loading = false,
  error = null,
}: {
  shipments: readonly SampleShipmentRecord[] | undefined;
  loading?: boolean;
  error?: string | null;
}) {
  const rows = shipments ?? [];
  return (
    <section
      data-testid="sample-shipment-history"
      className="grid gap-2 rounded-lg border border-line bg-paper px-3 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink-700">寄样记录</p>
        {!loading && !error && rows.length > 0 && (
          <span className="text-[10px] text-ink-400">{rows.length} 张寄样单</span>
        )}
      </div>
      {loading && <p className="text-xs text-ink-400">正在读取寄样记录…</p>}
      {!loading && error && <p className="text-xs text-rose-700">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="text-xs text-ink-400">
          这个样品还没有寄给过客户。点上方「建寄样单」可以先建一张草稿。
        </p>
      )}
      {rows.length > 0 && (
        <ul className="grid gap-2">
          {rows.map((shipment) => (
            <li
              key={shipment.id}
              className="grid gap-1 rounded-md border border-line bg-surface px-2.5 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-ink-900">{shipment.customerName}</span>
                <Badge tone={shipmentStatusTone(shipment.status)}>
                  {shipmentStatusLabel(shipment.status)}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
                {shipment.trackingNumber ? (
                  <span className="inline-flex items-center gap-1">
                    <span>
                      {shipment.carrier ? `${shipment.carrier} · ` : ""}
                      {shipment.trackingNumber}
                    </span>
                    <CopyTracking value={shipment.trackingNumber} />
                  </span>
                ) : (
                  <span>{logisticsText(shipment)}</span>
                )}
                <span>
                  {shipment.confirmedAt
                    ? `确认于 ${formatAt(shipment.confirmedAt)}`
                    : `建于 ${formatAt(shipment.createdAt)}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
