"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { AuditExportJob, AuditLogListItem } from "@weave-order/schema";
import {
  AUDIT_ACTION_LABEL,
  AUDIT_ENTITY_LABEL,
  auditActionLabel,
  auditEntityLabel,
  actorTypeLabel,
  auditScopeLabel,
  memberRoleLabel,
} from "@weave-order/schema";
import { useAuditLog, useAuditLogDetail, useAuditLogSummary } from "@weave-order/core";
import { AuditDiff, Badge, Button, EmptyState, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useCan } from "@/can";

/**
 * 操作日志页（WAN-179）。
 *
 * 只读是产品承诺：页面没有任何编辑 / 删除 / 撤销入口，服务端也没有对应路由。
 * 范围（全公司 / 我的操作）由 `/api/audit/log` 的 `scope` 决定，前端不猜角色。
 */

interface Filters {
  from: string;
  to: string;
  actor: string;
  action: string;
  entityType: string;
  keyword: string;
  highRisk: boolean;
}

const EMPTY_FILTERS: Filters = {
  from: "",
  to: "",
  actor: "",
  action: "",
  entityType: "",
  keyword: "",
  highRisk: false,
};

const SUMMARY_RANGES = [
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "90d", label: "近 90 天" },
  { value: "12m", label: "近 12 个月" },
  { value: "all", label: "全部" },
] as const;

const ACTION_OPTIONS = Object.entries(AUDIT_ACTION_LABEL).sort((a, b) =>
  a[1].localeCompare(b[1], "zh-CN"),
);

const ENTITY_OPTIONS = Object.entries(AUDIT_ENTITY_LABEL).sort((a, b) =>
  a[1].localeCompare(b[1], "zh-CN"),
);

/** 日志对象可点回业务页：没有详情页的实体保持纯文本，不给死链。 */
function entityHref(entityType: string, entityId: string): string | null {
  if (entityType === "customer") return `/panorama/customers/${entityId}`;
  if (entityType === "order") return `/panorama/orders/${entityId}`;
  if (entityType === "quote") return `/panorama/quotes?highlight=${entityId}`;
  if (entityType === "sample") return `/panorama/samples?sample=${entityId}`;
  return null;
}

/** 日期选择器按北京时间理解，避免用户在 23 点筛「今天」漏掉当天后半段。 */
function startOfDay(date: string): string | undefined {
  if (!date) return undefined;
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}
function endOfDay(date: string): string | undefined {
  if (!date) return undefined;
  return new Date(`${date}T23:59:59.999+08:00`).toISOString();
}

function dayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function dayLabel(key: string): string {
  const today = dayKey(new Date().toISOString());
  if (key === today) return `今天 · ${key}`;
  const date = new Date(`${key}T00:00:00+08:00`);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (key === dayKey(yesterday.toISOString())) return `昨天 · ${key}`;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function actorName(item: AuditLogListItem): string {
  if (item.actorType === "AGENT") return "小织（智能体）";
  if (item.actorType === "SYSTEM") return "系统";
  return item.actorName ?? "成员";
}

export function AuditLogView() {
  const api = useApi();
  const canExport = useCan("audit.read.own");

  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [range, setRange] = useState<(typeof SUMMARY_RANGES)[number]["value"]>("30d");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [exportJob, setExportJob] = useState<AuditExportJob | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = useMemo(
    () => ({
      from: startOfDay(filters.from) ?? null,
      to: endOfDay(filters.to) ?? null,
      actor: filters.actor.trim() || null,
      actions: filters.action ? [filters.action] : undefined,
      entityType: filters.entityType || null,
      keyword: filters.keyword.trim() || null,
      highRisk: filters.highRisk,
    }),
    [filters],
  );

  const log = useAuditLog(api, query);
  const summary = useAuditLogSummary(api, range);
  const scope = log.scope;
  const hasFilter =
    filters.from !== "" ||
    filters.to !== "" ||
    filters.actor !== "" ||
    filters.action !== "" ||
    filters.entityType !== "" ||
    filters.keyword !== "" ||
    filters.highRisk;

  // 按天分组：数据本身已按 seq（即时间）倒序，这里只切段，不重排。
  const groups = useMemo(() => {
    const map = new Map<string, AuditLogListItem[]>();
    for (const item of log.items) {
      const key = dayKey(item.createdAt);
      const bucket = map.get(key) ?? [];
      bucket.push(item);
      map.set(key, bucket);
    }
    return Array.from(map.entries());
  }, [log.items]);

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportJob(null);
    try {
      let job = await api.createAuditExport(query);
      setExportJob(job);
      // 小租户的 job 通常一秒内完成；最多等 60 秒，之后交回给用户重试。
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (job.status === "SUCCEEDED" || job.status === "FAILED") break;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        job = await api.auditExportJob(job.id);
        setExportJob(job);
      }
      if (job.status === "FAILED") setExportError(job.error ?? "导出失败");
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-ink-900">操作日志</h1>
            <Badge tone={scope === "ALL" ? "info" : "neutral"}>
              {scope ? auditScopeLabel(scope) : "读取中"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-ink-400">
            只追加记录，数据库层面不可修改。这里没有编辑、删除或撤销入口。
          </p>
        </div>
        {canExport && (
          <div className="flex items-center gap-2">
            {exportJob?.downloadUrl && (
              <a
                href={exportJob.downloadUrl}
                className="text-sm text-indigo-600 hover:underline"
                download={exportJob.fileName ?? undefined}
              >
                下载 CSV
              </a>
            )}
            <Button
              variant="secondary"
              className="min-h-9 px-3 text-sm"
              onClick={() => void exportCsv()}
              disabled={exporting}
            >
              {exporting
                ? "正在生成…"
                : exportJob?.status === "SUCCEEDED"
                  ? "重新导出"
                  : "导出日志"}
            </Button>
          </div>
        )}
      </header>

      {exportError && <p className="text-xs text-vermilion-600">{exportError}</p>}
      {exportJob && exportJob.status !== "FAILED" && !exportJob.downloadUrl && (
        <p className="text-xs text-ink-400">
          导出任务已提交（{exportJob.status === "PENDING" ? "排队中" : "生成中"}
          ），完成后这里会出现下载链接…
        </p>
      )}

      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <SummaryCard label="总操作数" value={summary.data?.total} range={range} />
        <SummaryCard label="高风险动作" value={summary.data?.highRiskCount} range={range} danger />
        <SummaryCard
          label="智能体操作"
          value={summary.data?.actorTypes.find((row) => row.actorType === "AGENT")?.count ?? 0}
          range={range}
        />
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <div className="text-xs text-ink-400">统计区间</div>
          <select
            value={range}
            onChange={(event) => setRange(event.target.value as typeof range)}
            className="mt-1 min-h-8 w-full rounded-md border border-line bg-surface text-sm text-ink-900"
          >
            {SUMMARY_RANGES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <label className="grid gap-1 text-xs text-ink-400">
          从
          <input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          />
        </label>
        <label className="grid gap-1 text-xs text-ink-400">
          到
          <input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          />
        </label>
        <label className="grid gap-1 text-xs text-ink-400">
          操作人
          <input
            value={draft.actor}
            onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
            placeholder="姓名或成员 ID"
            className="min-h-9 w-40 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          />
        </label>
        <label className="grid gap-1 text-xs text-ink-400">
          动作
          <select
            value={draft.action}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
            className="min-h-9 max-w-[180px] rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          >
            <option value="">全部动作</option>
            {ACTION_OPTIONS.map(([action, label]) => (
              <option key={action} value={action}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-ink-400">
          对象
          <select
            value={draft.entityType}
            onChange={(event) => setDraft({ ...draft, entityType: event.target.value })}
            className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          >
            <option value="">全部对象</option>
            {ENTITY_OPTIONS.map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-ink-400">
          关键词
          <input
            value={draft.keyword}
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") setFilters(draft);
            }}
            placeholder="客户名 / 单号 / 动作"
            className="min-h-9 w-44 rounded-md border border-line bg-surface px-2 text-sm text-ink-900"
          />
        </label>
        <label className="inline-flex min-h-9 items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={draft.highRisk}
            onChange={(event) => setDraft({ ...draft, highRisk: event.target.checked })}
          />
          只看高风险
        </label>
        <Button className="min-h-9 px-4 text-sm" onClick={() => setFilters(draft)}>
          查询
        </Button>
        {hasFilter && (
          <Button
            variant="ghost"
            className="min-h-9 px-3 text-xs"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setFilters(EMPTY_FILTERS);
            }}
          >
            清除筛选
          </Button>
        )}
      </section>

      {log.isLoading ? (
        <Spinner label="正在读取操作日志…" />
      ) : log.isError ? (
        <EmptyState
          title="操作日志暂时读不出来"
          description={log.error instanceof Error ? log.error.message : "请稍后重试"}
        />
      ) : log.items.length === 0 ? (
        <EmptyState
          title="没有符合条件的记录"
          description={
            hasFilter
              ? "放宽筛选再试，或清除筛选看全部。"
              : "业务动作会自动记录在这里，不需要手动维护。"
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {groups.map(([key, items]) => (
            <section key={key}>
              <h2 className="sticky top-0 z-10 border-y border-line bg-paper px-4 py-1.5 text-xs font-medium text-ink-400 first:border-t-0">
                {dayLabel(key)}
                <span className="ml-2 font-normal text-ink-400">{items.length} 条</span>
              </h2>
              <ul className="divide-y divide-line">
                {items.map((item) => {
                  const href = entityHref(item.entityType, item.entityId);
                  const open = expanded === item.seq;
                  return (
                    <li key={item.seq}>
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : item.seq)}
                        aria-expanded={open}
                        className="flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm hover:bg-paper md:items-center"
                      >
                        <span className="w-16 shrink-0 pt-0.5 font-mono text-xs text-ink-400 md:pt-0">
                          {timeLabel(item.createdAt)}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-6">
                          <span className="min-w-0 md:w-[22%] md:shrink-0">
                            <span className="block truncate text-ink-900">{actorName(item)}</span>
                            <span className="block text-xs text-ink-400">
                              {item.actorRole
                                ? memberRoleLabel(item.actorRole)
                                : actorTypeLabel(item.actorType)}
                            </span>
                          </span>
                          <span className="min-w-0 md:flex-1">
                            <span className="block truncate text-ink-700">
                              {auditActionLabel(item.action)}
                              {item.highRisk && (
                                <Badge tone="danger" className="ml-2 align-middle">
                                  高风险
                                </Badge>
                              )}
                            </span>
                            <span className="block truncate text-xs text-ink-400">
                              {auditEntityLabel(item.entityType)}
                              {item.entityLabel ? ` · ${item.entityLabel}` : ""}
                            </span>
                          </span>
                          <span className="min-w-0 text-xs text-ink-500 md:w-[22%] md:shrink-0">
                            {href ? (
                              <Link
                                href={href}
                                onClick={(event) => event.stopPropagation()}
                                className="text-indigo-600 hover:underline"
                              >
                                {item.entityLabel ?? "查看对象"}
                              </Link>
                            ) : (
                              <span className="block truncate">
                                {item.entityLabel ?? auditEntityLabel(item.entityType)}
                              </span>
                            )}
                          </span>
                        </span>
                        <span
                          aria-hidden
                          className={cn("shrink-0 text-ink-400", open && "rotate-90")}
                        >
                          ›
                        </span>
                      </button>
                      {open && <ExpandedDetail seq={item.seq} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {log.hasMore && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
          >
            {log.isFetchingNextPage ? "正在加载…" : "加载更早的记录"}
          </Button>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  range,
  danger = false,
}: {
  label: string;
  value: number | undefined;
  range: string;
  danger?: boolean;
}) {
  const rangeLabel = SUMMARY_RANGES.find((entry) => entry.value === range)?.label ?? range;
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-ink-400">
        {label}
        <span className="ml-1 text-[11px]">{rangeLabel}</span>
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-2xl font-bold tabular-nums",
          danger ? "text-vermilion-600" : "text-ink-900",
        )}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function ExpandedDetail({ seq }: { seq: number }) {
  const api = useApi();
  const detail = useAuditLogDetail(api, seq);
  if (detail.isLoading) {
    return (
      <div className="border-t border-line bg-paper px-6 py-3">
        <Spinner label="正在读取字段差异…" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="border-t border-line bg-paper px-6 py-3 text-xs text-vermilion-600">
        字段差异暂时读不出来，请稍后重试。
      </div>
    );
  }
  return (
    <div className="space-y-2 border-t border-line bg-paper px-6 py-3">
      <AuditDiff
        before={detail.data.before}
        after={detail.data.after}
        maskedFields={detail.data.maskedFields}
      />
      {detail.data.maskedFields.length > 0 && (
        <p className="text-[11px] text-ink-400">
          部分价格字段因权限限制已隐藏；摘要仍保留「改过价」这一事实。
        </p>
      )}
      <p className="font-mono text-[11px] text-ink-400">
        记录 #{detail.data.seq}
        {detail.data.correlationId ? ` · 关联 ${detail.data.correlationId}` : ""}
      </p>
    </div>
  );
}
