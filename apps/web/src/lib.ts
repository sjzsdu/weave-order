import type { Customer, ToolError } from "@weave-order/schema";

/** 金额（分）-> 展示字符串。只做展示，权威值始终来自后端内核。 */
export function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${currency} ${yuan}.${(abs % 100).toString().padStart(2, "0")}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** 客户名从只读目录里解析，找不到时退回短 id（不臆造名字）。 */
export function customerName(customers: Customer[], id: string): string {
  return customers.find((item) => item.id === id)?.name ?? shortId(id);
}

/** 状态色板：字面量 class 串，Tailwind 会从本文件扫描到这些候选类。 */
export function statusBadgeClass(status: string): string {
  if (status === "DRAFT") return "border-warn/60 text-warn bg-warn/10";
  if (status === "REJECTED" || status === "CANCELLED" || status === "EXPIRED") {
    return "border-danger/60 text-danger bg-danger/10";
  }
  return "border-accent/60 text-accent bg-accent/10";
}

/** 统一展示工具层可判别错误，未知 code 也如实呈现、不吞。 */
export function toolErrorText(error: ToolError): string {
  if (error.code === "INVALID_INPUT") {
    return `输入校验失败：${error.issues.map((issue) => issue.message).join("；")}`;
  }
  return `${error.code}：${error.message}`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
