import { ZodError } from "zod";
import type { ToolError, ZodIssueSummary } from "@weave-order/schema";
import { isKernelError } from "../kernel";

function issuesOf(error: ZodError): ZodIssueSummary[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
    code: issue.code,
    message: issue.message,
  }));
}

/** Zod 校验失败 -> INVALID_INPUT（携带逐字段 issues，前端可直接标注）。 */
export function invalidInput(error: ZodError): ToolError {
  return {
    code: "INVALID_INPUT",
    message: "工具输入未通过 Schema 校验",
    issues: issuesOf(error),
  };
}

/** 把内核失败 / 未知异常统一收敛到封闭的 ToolError 集合。 */
export function toToolError(error: unknown): ToolError {
  if (isKernelError(error)) return error.toToolError();
  if (error instanceof ZodError) return invalidInput(error);
  return {
    code: "INTERNAL",
    message: error instanceof Error ? error.message : "未知错误",
  };
}
