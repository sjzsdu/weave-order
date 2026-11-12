import type { RevisionDiff } from "@weave-order/schema";
import { cn } from "./primitives";

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * 一行 diff：原值划掉 → 新值高亮。
 * 屏幕阅读器读「原 X，改为 Y」。
 */
export function DiffRow({ diff }: { diff: RevisionDiff }) {
  const before = display(diff.before);
  const after = display(diff.after);
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="text-xs text-ink-400">{diff.field}</div>
        <div className="truncate text-ink-400 line-through">{before}</div>
      </div>
      <span aria-hidden className="text-ink-400">
        →
      </span>
      <div className="min-w-0 text-right">
        <span className="sr-only">{`原 ${before}，改为 ${after}`}</span>
        <div aria-hidden className={cn("truncate font-medium", before === after ? "text-ink-400" : "text-vermilion-600")}>
          {after}
        </div>
      </div>
    </div>
  );
}
