"use client";

import { useSearchParams } from "next/navigation";
import { InboundComposer } from "@/inbound-composer";

/**
 * 统一输入页。
 *
 * `?text=` 是旧入口（today / ⌘K / 客户 360）迁过来的唯一方式：
 * 它们不再各自提交 `/api/intents`，而是把原话带到这里，共用一条输入路径。
 * 客户 360 / 开张清单还会带上 customerId / sampleId，作为理解与执行的上下文。
 */
export default function InboundPage() {
  const params = useSearchParams();
  const context: Record<string, string> = {};
  for (const key of ["customerId", "customerName", "customerCode", "sampleId", "sampleCode"]) {
    const value = params.get(key);
    if (value) context[key] = value;
  }
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <InboundComposer
        initialText={params.get("text") ?? ""}
        {...(Object.keys(context).length > 0 ? { initialContext: context } : {})}
      />
    </div>
  );
}
