import type { ApprovalRisk } from "@weave-order/schema";
import { Badge } from "./primitives";

const TONE = { LOW: "neutral", MEDIUM: "warning", HIGH: "danger" } as const;
const LABEL = { LOW: "低风险", MEDIUM: "注意", HIGH: "高风险" } as const;

/** 风险只给等级与可核验理由，不给置信度百分比（伪精确）。 */
export function RiskBadge({ risk }: { risk: ApprovalRisk }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={TONE[risk.level]}>{LABEL[risk.level]}</Badge>
      {risk.reasons.length > 0 && (
        <span className="text-xs text-ink-400">{risk.reasons.join(" · ")}</span>
      )}
    </span>
  );
}
