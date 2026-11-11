import type { ToolError } from "@weave-order/schema";

/** 内核失败码：与工具层 ToolError 的 code 一一对应，避免两套语义。 */
export type KernelErrorCode =
  "CUSTOMER_NOT_FOUND" | "RESOURCE_NOT_FOUND" | "KERNEL_REJECTED" | "PERMISSION_DENIED";

export interface KernelErrorDetails {
  customerId?: string;
  resourceType?: string;
  resourceId?: string;
  reason?: string;
}

/**
 * 内核拒绝/失败。工具层是唯一把它转成 ToolError 的地方，
 * 内核自身不返回任何「看起来像成功」的模糊状态。
 */
export class KernelError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    message: string,
    readonly details: KernelErrorDetails = {},
  ) {
    super(message);
    this.name = "KernelError";
  }

  toToolError(): ToolError {
    switch (this.code) {
      case "CUSTOMER_NOT_FOUND":
        return {
          code: "CUSTOMER_NOT_FOUND",
          message: this.message,
          customerId: this.details.customerId ?? "",
        };
      case "RESOURCE_NOT_FOUND":
        return {
          code: "RESOURCE_NOT_FOUND",
          message: this.message,
          resourceType: this.details.resourceType ?? "unknown",
          resourceId: this.details.resourceId ?? "",
        };
      case "KERNEL_REJECTED":
        return {
          code: "KERNEL_REJECTED",
          message: this.message,
          reason: this.details.reason ?? "UNSPECIFIED",
        };
      case "PERMISSION_DENIED":
        return { code: "PERMISSION_DENIED", message: this.message };
    }
  }
}

export function isKernelError(error: unknown): error is KernelError {
  return error instanceof KernelError;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

/** drizzle 会把驱动错误包一层（DrizzleQueryError），真实的 PG code 在 cause 链上。 */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && !chain.includes(current)) {
    chain.push(current);
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}

/** PostgreSQL 唯一键冲突（23505）判定（沿 cause 链查找）。 */
export function isUniqueViolation(error: unknown): boolean {
  return causeChain(error).some(
    (item) => typeof item === "object" && item !== null && (item as PgErrorLike).code === "23505",
  );
}

/** 把 cause 链拼成一条可读消息，便于日志与演示输出定位真实原因。 */
export function errorChainMessage(error: unknown): string {
  return causeChain(error)
    .map((item) => (item instanceof Error ? item.message : String(item)))
    .join(" ← ");
}
