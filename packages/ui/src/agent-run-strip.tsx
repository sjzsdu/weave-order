import type { ReactNode } from "react";
import { cn } from "./primitives";

export interface AgentRun {
  id: string;
  agent: string;
  what: string;
  status: "running" | "done" | "failed" | "waiting";
  hint?: string;
}

const STATUS_LABEL = {
  running: "进行中",
  done: "已完成",
  failed: "失败",
  waiting: "等你",
} as const;

const DOT = {
  running: "bg-indigo-600 animate-pulse",
  done: "bg-moss-600",
  failed: "bg-vermilion-600",
  waiting: "bg-amber-600",
} as const;

/** 工作台的「同事汇报」条：每个智能体一行，必须带「为什么」。 */
export function AgentRunStrip({
  runs,
  onOpen,
  empty,
}: {
  runs: AgentRun[];
  onOpen?: (run: AgentRun) => void;
  empty?: ReactNode;
}) {
  if (runs.length === 0) {
    return <>{empty ?? <p className="text-sm text-ink-400">今天没有智能体动态。</p>}</>;
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => onOpen?.(run)}
            className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-paper/60"
          >
            <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[run.status])} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-sm text-ink-900">
                <span className="font-medium">{run.agent}</span>
                <span className="text-ink-700">{run.what}</span>
              </span>
              {run.hint && <span className="mt-0.5 block text-xs text-ink-400">{run.hint}</span>}
            </span>
            <span className="shrink-0 text-xs text-ink-400">{STATUS_LABEL[run.status]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
