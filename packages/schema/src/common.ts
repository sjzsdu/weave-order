import { z } from "zod";

/**
 * 契约包这一份 zod 的 ZodError 类。
 *
 * 跨包做 `instanceof` / `@Catch` 必须用它：消费方直接 `import "zod"` 时可能拿到
 * 另一份实例（vitest 的模块图里，dist 走 CJS、api 走 ESM），判定会静默失效——
 * 同 `apps/api/src/approval/approval.service.ts` 里改用形状判定的原因。
 */
export { ZodError as ContractZodError } from "zod";

/**
 * 工具层统一失败语义。
 *
 * 契约铁律：任何工具失败都必须落到这里定义的、以 `code` 区分的
 * 可判别联合（discriminated union）上。调用方（智能体编排层 / 前端审批窗口）
 * 可以 `switch (error.code)` 精确分流，不存在需要猜测语义的错误状态。
 *
 * 每一个 `code` 对应一种明确、可区分的失败原因，禁止用笼统字符串掩盖语义。
 */

/** Zod 校验失败时携带的 issue 摘要（剔除 zod 内部实现细节，保持契约稳定）。 */
export const ZodIssueSummary = z.object({
  /** 问题所在的 JSON 路径，如 ["items", 0, "unitPrice", "amount"] */
  path: z.array(z.union([z.string(), z.number()])),
  /** 问题类型，如 "too_small" / "invalid_type" */
  code: z.string(),
  /** 人类可读的问题描述 */
  message: z.string(),
});
export type ZodIssueSummary = z.infer<typeof ZodIssueSummary>;

/** 输入未通过 Schema 校验（携带结构化 issues，供前端逐字段标注）。 */
const InvalidInputError = z.object({
  code: z.literal("INVALID_INPUT"),
  message: z.string(),
  issues: z.array(ZodIssueSummary),
});

/** 客户不存在。 */
const CustomerNotFoundError = z.object({
  code: z.literal("CUSTOMER_NOT_FOUND"),
  message: z.string(),
  customerId: z.string(),
});

/** 通用资源不存在（样品 / 订单 / 报价单等）。 */
const ResourceNotFoundError = z.object({
  code: z.literal("RESOURCE_NOT_FOUND"),
  message: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
});

/** 当前审批上下文无权执行该操作。 */
const PermissionDeniedError = z.object({
  code: z.literal("PERMISSION_DENIED"),
  message: z.string(),
});

/** 确定性内核拒绝（账本规则 / 审计约束，如单价低于成本线、库存不足）。 */
const KernelRejectedError = z.object({
  code: z.literal("KERNEL_REJECTED"),
  message: z.string(),
  /** 内核给出的具体拒绝原因（业务规则码或说明） */
  reason: z.string(),
});

/** 金额未经确定性内核计算，拒绝信任该结果。 */
const AmountNotAuthoritativeError = z.object({
  code: z.literal("AMOUNT_NOT_AUTHORITATIVE"),
  message: z.string(),
});

/** 上游依赖不可用（数据库 / 向量库 / 模型服务等）。 */
const UpstreamUnavailableError = z.object({
  code: z.literal("UPSTREAM_UNAVAILABLE"),
  message: z.string(),
  dependency: z.string(),
});

/** 未预期的内部错误。 */
const InternalError = z.object({
  code: z.literal("INTERNAL"),
  message: z.string(),
});

/** 工具失败的完整可判别联合。 */
export const ToolError = z.discriminatedUnion("code", [
  InvalidInputError,
  CustomerNotFoundError,
  ResourceNotFoundError,
  PermissionDeniedError,
  KernelRejectedError,
  AmountNotAuthoritativeError,
  UpstreamUnavailableError,
  InternalError,
]);
export type ToolError = z.infer<typeof ToolError>;

/** 工具错误码的并集，供上游做穷尽性 `switch` 判定的类型提示。 */
export type ToolErrorCode = ToolError["code"];

/** 工具调用成功分支。 */
export type ToolSuccess<T> = { ok: true; data: T };
/** 工具调用失败分支。 */
export type ToolFailure = { ok: false; error: ToolError };
/** 工具调用的统一结果：`ok` 字段是可判别联合的判别键。 */
export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

/**
 * 构造一个工具结果 Schema：成功分支携带 `data`，失败分支携带 `ToolError`。
 * 这是所有工具输出 Schema 的唯一构造入口，保证失败语义全局一致。
 */
export function toolResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }),
    z.object({ ok: z.literal(false), error: ToolError }),
  ]);
}

/**
 * 内核状态 / 版本 / 唯一键冲突：重试前必须先读到最新状态。
 * 其余 KERNEL_REJECTED 是「入参合法但业务规则不接受」，落到 422。
 */
const CONFLICT_REASONS = new Set([
  "VERSION_CONFLICT",
  "INVALID_STATE_TRANSITION",
  "CUSTOMER_CODE_EXISTS",
  "MEMBERSHIP_EXISTS",
  "PRICING_POLICY_EXISTS",
  "REVISION_REASON_EXISTS",
  "SAMPLE_CODE_EXISTS",
  "TENANT_SLUG_EXISTS",
]);

/**
 * 工具失败 -> HTTP 状态码：body 的 `{ok:false,error}` 契约不变，只把状态码还给
 * HTTP（网关指标、重试策略与 agent 判错都读状态码）。服务端的拦截器与端侧
 * mock 都从这里取，避免两处映射各自漂移。
 */
export function statusForToolFailure(error: ToolError): number {
  switch (error.code) {
    case "INVALID_INPUT":
      return 400;
    case "PERMISSION_DENIED":
      return 403;
    case "CUSTOMER_NOT_FOUND":
    case "RESOURCE_NOT_FOUND":
      return 404;
    case "AMOUNT_NOT_AUTHORITATIVE":
      return 422;
    case "UPSTREAM_UNAVAILABLE":
      return 502;
    case "INTERNAL":
      return 500;
    case "KERNEL_REJECTED":
      return CONFLICT_REASONS.has(error.reason) ? 409 : 422;
  }
}
