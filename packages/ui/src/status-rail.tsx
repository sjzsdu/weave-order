import { cn } from "./primitives";

export interface StatusRailStep {
  key: string;
  label: string;
  status: "done" | "current" | "todo" | "failed";
}

/** 单据生命周期：草稿 → 审批 → 生效。状态变化才用动效。 */
export function StatusRail({ steps, className }: { steps: StatusRailStep[]; className?: string }) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-2", className)} aria-label="单据状态">
      {steps.map((step, index) => (
        <li key={step.key} className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex h-6 items-center rounded-full px-2.5 text-xs",
              step.status === "done" && "bg-moss-600/10 text-moss-600",
              step.status === "current" && "bg-indigo-100 text-indigo-600 ring-1 ring-indigo-600/30",
              step.status === "todo" && "bg-paper text-ink-400",
              step.status === "failed" && "bg-vermilion-600/10 text-vermilion-600",
            )}
          >
            {step.label}
          </span>
          {index < steps.length - 1 && <span aria-hidden className="text-xs text-line">—</span>}
        </li>
      ))}
    </ol>
  );
}
