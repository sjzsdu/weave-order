import type { FabricSample } from "@weave-order/schema";
import { sampleWeightText } from "@weave-order/schema";
import { Badge, cn } from "./primitives";

/**
 * 找样候选 / 图墙卡片：有图渲染缩略图，无图显示「待补图」占位。
 * 不用斜纹伪装色卡 —— 没图就是没图，补图入口由调用方给。
 */
export function SampleTile({
  sample,
  imageUrl,
  reason,
  selected,
  onSelect,
}: {
  sample: Pick<FabricSample, "id" | "code" | "name" | "composition" | "weight" | "unit"> & {
    primaryImageUrl?: string | null;
  };
  /** 覆盖 `sample.primaryImageUrl`（例如缩略图地址）。 */
  imageUrl?: string | null;
  reason?: string;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const thumb = imageUrl ?? sample.primaryImageUrl ?? null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-indigo-600 ring-1 ring-indigo-600/30"
          : "border-line hover:border-ink-400",
      )}
    >
      {thumb ? (
        <img
          src={thumb}
          alt={`${sample.name} 样品图`}
          loading="lazy"
          decoding="async"
          className="mt-0.5 h-12 w-12 shrink-0 rounded-md border border-line object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-line bg-paper text-[10px] text-ink-400"
        >
          待补图
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-ink-900">{sample.name}</span>
          <Badge tone="neutral">{sample.code}</Badge>
        </span>
        <span className="mt-0.5 block text-xs text-ink-400">
          {[sample.composition, sampleWeightText(null, sample.weight)]
            .filter(Boolean)
            .join(" · ") || "规格未填"}
        </span>
        {reason && <span className="mt-1 block text-xs text-indigo-600">命中：{reason}</span>}
      </span>
    </button>
  );
}
