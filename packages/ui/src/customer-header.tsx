import type { Customer } from "@weave-order/schema";
import { Badge } from "./primitives";

const TIER_LABEL: Record<string, string> = {
  VIP: "VIP",
  REGULAR: "常规",
  NEW: "新客",
  COLD: "沉睡",
};

/** 等级文案：预置项用中文，自定义等级暂时回退到 code（P1 由 field_options.label 接管）。 */
function tierLabel(tier: string): string {
  return TIER_LABEL[tier] ?? tier;
}

/** 客户抬头：先给结论（谁、什么等级、怎么联系），再给细节。 */
export function CustomerHeader({
  customer,
  meta,
}: {
  customer: Pick<Customer, "name" | "code" | "tier" | "contactName" | "contactPhone">;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-ink-900">{customer.name}</h2>
          <Badge tone={customer.tier === "VIP" ? "info" : "neutral"}>
            {tierLabel(customer.tier)}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-ink-400">
          {customer.code}
          {customer.contactName ? ` · ${customer.contactName}` : ""}
          {customer.contactPhone ? ` · ${customer.contactPhone}` : ""}
        </p>
        {meta}
      </div>
    </div>
  );
}
