import type { FabricSample } from "@weave-order/schema";
import { Badge, cn } from "./primitives";

/** 找样候选：色卡占位 + 规格 + 命中理由（理由由后端给）。 */
export function SampleTile({
  sample,
  reason,
  selected,
  onSelect,
}: {
  sample: Pick<FabricSample, "id" | "code" | "name" | "composition" | "weight" | "unit">;
  reason?: string;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-indigo-600 ring-1 ring-indigo-600/30" : "border-line hover:border-ink-400",
      )}
    >
      <span
        aria-hidden
        className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-line bg-paper text-xs text-ink-400"
        style={{ backgroundImage: "repeating-linear-gradient(45deg, #F7F4EE, #F7F4EE 4px, #FFFFFF 4px, #FFFFFF 8px)" }}
      >
        色卡
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-ink-900">{sample.name}</span>
          <Badge tone="neutral">{sample.code}</Badge>
        </span>
        <span className="mt-0.5 block text-xs text-ink-400">
          {[sample.composition, sample.weight].filter(Boolean).join(" · ") || "规格未填"}
        </span>
        {reason && <span className="mt-1 block text-xs text-indigo-600">命中：{reason}</span>}
      </span>
    </button>
  );
}
