import type { ApprovalMissingField } from "@weave-order/schema";
import { Badge } from "./primitives";

/** 缺失项是「待补」，不是错误：一律黄色徽标，不用红色。 */
export function MissingFieldBadge({ field }: { field: ApprovalMissingField }) {
  return (
    <Badge tone="warning" className="max-w-full">
      <span aria-hidden>!</span>
      <span className="truncate">缺 {field.label}</span>
      {field.hint && <span className="hidden truncate font-normal opacity-80 sm:inline">· {field.hint}</span>}
    </Badge>
  );
}
