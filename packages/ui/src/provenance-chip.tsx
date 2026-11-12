import type { ApprovalProvenance, ProvenanceKind } from "@weave-order/schema";
import { cn } from "./primitives";

const ICON: Record<ProvenanceKind, string> = {
  HISTORY: "◷",
  COST: "¥",
  STOCK: "▤",
  POLICY: "§",
  CUSTOMER: "◉",
  AGENT: "✦",
  AUDIT: "✓",
};

/** 每个数字都可点开看来源；展开后显示后端给出的 detail。 */
export function ProvenanceChip({ entry }: { entry: ApprovalProvenance }) {
  return (
    <details className="group rounded-md border border-line bg-surface px-3 py-2 text-sm open:bg-paper/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-ink-700">
        <span aria-hidden className="text-indigo-600">
          {ICON[entry.kind]}
        </span>
        <span className="text-ink-400">{entry.label}</span>
        <span className="truncate font-medium text-ink-900">{entry.value}</span>
        <span className="ml-auto text-xs text-ink-400 group-open:hidden">展开</span>
        <span className="ml-auto hidden text-xs text-ink-400 group-open:inline">收起</span>
      </summary>
      <p className={cn("mt-2 border-t border-line pt-2 text-[13px] leading-relaxed text-ink-700")}>
        {entry.detail ?? "暂无更多说明"}
      </p>
    </details>
  );
}

export function ProvenanceList({ entries }: { entries: ApprovalProvenance[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-ink-400">这份草稿没有记录出处。</p>;
  }
  return (
    <div className="grid gap-2">
      {entries.map((entry) => (
        <ProvenanceChip key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
