import { cn } from "./primitives";

/** 网络断开时只说明「已存本地、联网自动提交」，不阻断当前阅读。 */
export function OfflineBanner({
  pending = 0,
  onViewQueue,
  className,
}: {
  pending?: number;
  onViewQueue?: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-2 text-sm text-amber-600",
        className,
      )}
    >
      <span>已存本地，联网后自动提交（{pending} 条）。只读内容不受影响。</span>
      {onViewQueue && (
        <button type="button" onClick={onViewQueue} className="text-xs underline underline-offset-2">
          查看队列
        </button>
      )}
    </div>
  );
}
