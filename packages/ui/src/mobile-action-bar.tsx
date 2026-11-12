import type { ReactNode } from "react";
import { cn } from "./primitives";

/** 移动端拇指区：主操作在右，驳回在左；桌面端不渲染。 */
export function MobileActionBar({
  reject,
  secondary,
  approve,
  className,
}: {
  reject?: ReactNode;
  secondary?: ReactNode;
  approve: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-line bg-surface/95 px-4 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3 backdrop-blur md:hidden",
        className,
      )}
    >
      {reject}
      <div className="ml-auto flex items-center gap-2">
        {secondary}
        {approve}
      </div>
    </div>
  );
}
