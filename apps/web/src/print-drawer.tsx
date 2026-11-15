"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PrintDocumentKindLabel, type PrintJob, type PrintTemplate } from "@weave-order/schema";
import { Badge, Button, EmptyState, Spinner, cn } from "@weave-order/ui";
import {
  useCancelPrintJob,
  usePrintCenter,
  useRegisterPrintAgent,
  useRetryPrintJob,
} from "@weave-order/core";
import { useApi } from "@/providers";
import { relativeTime } from "@/format";

const TABS = ["队列", "模板", "设备", "记录"] as const;
type Tab = (typeof TABS)[number];

const STATUS_LABEL: Record<PrintJob["status"], string> = {
  QUEUED: "待打",
  SENT: "已下发",
  PRINTING: "打印中",
  DONE: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};

const STATUS_TONE: Record<PrintJob["status"], "neutral" | "info" | "danger" | "success"> = {
  QUEUED: "neutral",
  SENT: "info",
  PRINTING: "info",
  DONE: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
};

const SCOPE_LABEL = {
  SYSTEM: "系统",
  COMPANY: "公司覆盖",
  DOCUMENT_TYPE: "单据类型覆盖",
} as const;

const FORMAT_LABEL = { HTML: "A4 · HTML", ZPL: "热敏 · ZPL", TSPL: "热敏 · TSPL" } as const;

function timeLabel(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 打印中心是全局抽屉，不是第四个窗口（IA 铁律）。
 * 入口只有顶栏「打印」、单据详情「打印」、手机扫码；这里只是队列/模板/设备/记录。
 */
export function PrintDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const center = usePrintCenter(api);
  const cancel = useCancelPrintJob(api);
  const retry = useRetryPrintJob(api);
  const register = useRegisterPrintAgent(api);
  const [tab, setTab] = useState<Tab>("队列");
  const [agentName, setAgentName] = useState("仓库打印代理");
  const [agentLocation, setAgentLocation] = useState("仓库");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const data = center.data;
  const jobs = data?.queue.jobs ?? [];
  const counts = data?.queue.counts;
  const agents = data?.devices.agents ?? [];
  const online = agents.filter((agent) => agent.status === "ONLINE").length;
  const pending = data?.pendingShipments ?? [];

  async function run(action: () => Promise<unknown>, done: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    }
  }

  // 关闭时不要留在 DOM 里：`fixed` + `translate-x-full` 仍会撑出横向滚动区域
  // （375px 桌面视口下实测 document.scrollWidth 多出 66px）。
  if (!open) return null;

  return (
    <div aria-hidden={!open} className={open ? "" : "pointer-events-none"}>
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-label="关闭打印中心"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-ink-900/20 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="打印中心"
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col border-l border-line bg-surface shadow-xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">打印中心</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              代理 {online}/{agents.length} 在线 · 待打 {counts?.queued ?? 0} · 失败{" "}
              {counts?.failed ?? 0}
            </p>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="关闭">
            ✕
          </Button>
        </header>

        <div className="flex gap-1 border-b border-line px-5 pt-3">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={cn(
                "min-h-9 rounded-t-md px-3 py-2 text-sm",
                tab === item
                  ? "border-b-2 border-indigo-600 text-indigo-600"
                  : "text-ink-400 hover:text-ink-700",
              )}
            >
              {item}
              {item === "队列" && (counts?.queued ?? 0) > 0 && (
                <Badge tone="info" className="ml-1">
                  {counts?.queued}
                </Badge>
              )}
              {item === "设备" && agents.length > 0 && (
                <Badge tone="neutral" className="ml-1">
                  {agents.length}
                </Badge>
              )}
            </button>
          ))}
        </div>

        {(error || notice) && (
          <p
            className={cn(
              "mx-5 mt-3 rounded-md border px-3 py-2 text-sm",
              error
                ? "border-vermilion-600/30 bg-vermilion-600/10 text-vermilion-600"
                : "border-moss-600/30 bg-moss-600/10 text-moss-600",
            )}
          >
            {error ?? notice}
          </p>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {center.isLoading ? (
            <Spinner label="正在读取打印队列…" />
          ) : center.isError ? (
            <EmptyState
              title="打印中心暂时不可用"
              description={center.error instanceof Error ? center.error.message : "请稍后重试"}
            />
          ) : tab === "队列" ? (
            <QueueTab
              jobs={jobs}
              onCancel={(id) => void run(() => cancel.mutateAsync(id), "任务已取消")}
              onRetry={(id) => void run(() => retry.mutateAsync(id), "任务已重新排队")}
            />
          ) : tab === "模板" ? (
            <TemplatesTab templates={data?.templates ?? []} />
          ) : tab === "设备" ? (
            <DevicesTab
              agents={agents}
              token={token}
              agentName={agentName}
              agentLocation={agentLocation}
              busy={register.isPending}
              onName={setAgentName}
              onLocation={setAgentLocation}
              onRegister={() => {
                setError(null);
                setToken(null);
                void register
                  .mutateAsync({ name: agentName, location: agentLocation })
                  .then((result) => {
                    setToken(result.token);
                    setNotice("代理已注册：token 只显示这一次，请粘贴到打印代理配置里。");
                  })
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "注册失败"),
                  );
              }}
            />
          ) : (
            <LogsTab logs={data?.logs ?? []} />
          )}
        </div>

        <footer className="border-t border-line px-5 py-3">
          {pending.length > 0 && (
            <div className="mb-2">
              <p className="text-[11px] uppercase tracking-wide text-ink-400">待发货</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {pending.slice(0, 4).map((order) => (
                  <Link
                    key={order.orderId}
                    href={`/shipping/${order.orderId}`}
                    onClick={onClose}
                    className="rounded-md border border-line px-2 py-1 text-xs text-indigo-600 hover:border-indigo-600"
                  >
                    {order.orderNo} · {order.customerName}
                  </Link>
                ))}
              </div>
            </div>
          )}
          <p className="text-[11px] text-ink-400">
            打印是全局抽屉：队列 / 模板 / 设备 / 记录，不新增一级导航。
          </p>
        </footer>
      </aside>
    </div>
  );
}

function QueueTab({
  jobs,
  onCancel,
  onRetry,
}: {
  jobs: PrintJob[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <EmptyState
        title="队列里还没有打印任务"
        description="在发货单里点「一键打印」，拣货单、箱唛、发货单会在这里排队。"
      />
    );
  }
  return (
    <ul className="grid gap-2">
      {jobs.map((job) => (
        <li key={job.id} className="rounded-md border border-line px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink-900">
                {PrintDocumentKindLabel[job.kind]}
                {job.labelSeq ? ` · 标签 #${job.labelSeq}` : ""}
                <span className="ml-2 text-xs text-ink-400">{job.copies} 份</span>
              </p>
              <p className="mt-0.5 text-xs text-ink-400">
                {job.format === "HTML" ? "A4 PDF" : job.format} · {job.requestedBy} ·{" "}
                {relativeTime(job.createdAt)}
                {job.reprintReason ? ` · 补打：${job.reprintReason}` : ""}
              </p>
              {job.lastError && <p className="mt-1 text-xs text-vermilion-600">{job.lastError}</p>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</Badge>
              {job.status === "FAILED" && (
                <button
                  type="button"
                  onClick={() => onRetry(job.id)}
                  className="text-xs text-indigo-600 underline underline-offset-2"
                >
                  重试
                </button>
              )}
              {(job.status === "QUEUED" || job.status === "SENT") && (
                <button
                  type="button"
                  onClick={() => onCancel(job.id)}
                  className="text-xs text-ink-400 underline underline-offset-2"
                >
                  取消
                </button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function TemplatesTab({ templates }: { templates: PrintTemplate[] }) {
  if (templates.length === 0) {
    return (
      <EmptyState
        title="还没有模板"
        description="系统模板会随版本内置，公司覆盖发布后出现在这里。"
      />
    );
  }
  return (
    <ul className="grid gap-2">
      {templates.map((template) => (
        <li key={template.id} className="rounded-md border border-line px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink-900">{template.name}</p>
              <p className="mt-0.5 text-xs text-ink-400">
                {PrintDocumentKindLabel[template.kind]} · {FORMAT_LABEL[template.format]} ·{" "}
                {SCOPE_LABEL[template.scope]}
                {template.activeVersion ? ` · v${template.activeVersion.version}` : ""}
              </p>
            </div>
            <Badge tone={template.isSystem ? "neutral" : "info"}>
              {template.isSystem ? "系统" : `${template.versionCount} 版`}
            </Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DevicesTab({
  agents,
  token,
  agentName,
  agentLocation,
  busy,
  onName,
  onLocation,
  onRegister,
}: {
  agents: Array<{
    id: string;
    name: string;
    location: string | null;
    status: "ONLINE" | "OFFLINE" | "DISABLED";
    appVersion: string | null;
    lastSeenAt: string | null;
    printers: Array<{ id: string; name: string; kind: string; connection: string; status: string }>;
  }>;
  token: string | null;
  agentName: string;
  agentLocation: string;
  busy: boolean;
  onName: (value: string) => void;
  onLocation: (value: string) => void;
  onRegister: () => void;
}) {
  return (
    <div className="grid gap-4">
      <section className="grid gap-2">
        {agents.length === 0 ? (
          <EmptyState
            title="还没有打印代理"
            description="在办公室/仓库的一台常开电脑上安装打印代理，注册后会自动发现打印机。"
          />
        ) : (
          agents.map((agent) => (
            <div key={agent.id} className="rounded-md border border-line px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink-900">{agent.name}</p>
                  <p className="text-xs text-ink-400">
                    {agent.location ?? "未标注位置"} · {agent.appVersion ?? "版本未知"} ·{" "}
                    {agent.lastSeenAt ? timeLabel(agent.lastSeenAt) : "从未上线"}
                  </p>
                </div>
                <Badge
                  tone={
                    agent.status === "ONLINE"
                      ? "success"
                      : agent.status === "DISABLED"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {agent.status === "ONLINE"
                    ? "在线"
                    : agent.status === "DISABLED"
                      ? "已禁用"
                      : "离线"}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {agent.printers.length === 0 ? (
                  <span className="text-xs text-ink-400">未上报打印机</span>
                ) : (
                  agent.printers.map((printer) => (
                    <span
                      key={printer.id}
                      className="rounded border border-line px-2 py-0.5 text-xs text-ink-700"
                    >
                      {printer.name} · {printer.kind} · {printer.status}
                    </span>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="rounded-md border border-dashed border-line px-3 py-3">
        <p className="text-sm font-medium text-ink-900">注册打印代理</p>
        <p className="mt-0.5 text-xs text-ink-400">
          token 只能打印、不能读业务数据；明文只显示一次。
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={agentName}
            onChange={(event) => onName(event.target.value)}
            placeholder="代理名称"
            className="min-h-9 flex-1 rounded-md border border-line bg-paper px-2 text-sm"
          />
          <input
            value={agentLocation}
            onChange={(event) => onLocation(event.target.value)}
            placeholder="位置"
            className="min-h-9 w-24 rounded-md border border-line bg-paper px-2 text-sm"
          />
          <Button variant="primary" onClick={onRegister} disabled={busy}>
            {busy ? "注册中…" : "注册"}
          </Button>
        </div>
        {token && (
          <div className="mt-2 rounded-md bg-paper px-2 py-2">
            <p className="text-xs text-ink-400">复制到打印代理的 token 输入框（只显示一次）：</p>
            <code className="mt-1 block break-all text-xs text-ink-900">{token}</code>
          </div>
        )}
      </section>
    </div>
  );
}

function LogsTab({
  logs,
}: {
  logs: Array<{
    id: string;
    kind: PrintJob["kind"];
    status: PrintJob["status"];
    copies: number;
    boxNo: string | null;
    requestedBy: string;
    reprintReason: string | null;
    message: string | null;
    createdAt: string;
  }>;
}) {
  if (logs.length === 0) {
    return (
      <EmptyState
        title="还没有打印记录"
        description="每次打印都会留下：谁、何时、哪版、几份、结果。"
      />
    );
  }
  return (
    <ul className="grid gap-1.5">
      {logs.map((log) => (
        <li
          key={log.id}
          className="flex items-center justify-between gap-3 border-b border-line/70 py-1.5"
        >
          <div>
            <p className="text-sm text-ink-900">
              {PrintDocumentKindLabel[log.kind]}
              {log.boxNo ? ` · ${log.boxNo}` : ""}
              <span className="ml-2 text-xs text-ink-400">{log.copies} 份</span>
            </p>
            <p className="text-xs text-ink-400">
              {timeLabel(log.createdAt)} · {log.requestedBy}
              {log.reprintReason ? ` · 补打：${log.reprintReason}` : ""}
              {log.message ? ` · ${log.message}` : ""}
            </p>
          </div>
          <Badge tone={STATUS_TONE[log.status]}>{STATUS_LABEL[log.status]}</Badge>
        </li>
      ))}
    </ul>
  );
}
