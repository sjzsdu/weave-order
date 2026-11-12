import { HttpException } from "@nestjs/common";
import type { ZodIssueSummary } from "@weave-order/schema";
import { isKernelError } from "../kernel";

/**
 * 写接口的错误表达。
 *
 * 目标：录入失败必须是「看得懂的原因」，而不是 500。校验失败回 400、
 * 重复回 409，响应体与工具层的失败语义同构（`{ ok: false, error }`），
 * 前端可以原样展示 `error.message`，也可以按 `issues[].path` 标注字段。
 */

/** 字段名 -> 中文标签，只为可读性服务，不影响契约。 */
const FIELD_LABELS: Record<string, string> = {
  code: "编号",
  name: "名称",
  tier: "客户等级",
  contactName: "联系人",
  contactPhone: "联系电话",
  contactEmail: "联系邮箱",
  composition: "成分",
  weight: "克重",
  unit: "计量单位",
  costFloor: "成本底线",
  status: "状态",
};

interface ZodIssueLike {
  path?: unknown;
  code?: unknown;
  message?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  type?: unknown;
  options?: unknown;
  validation?: unknown;
  keys?: unknown;
  received?: unknown;
}

/**
 * 用形状判定 ZodError（跨 zod 实例同样稳定，理由同 approval.service）。
 * 返回原始 issue 列表；不是校验错误则返回 null。
 */
function zodIssuesOf(error: unknown): ZodIssueLike[] | null {
  if (typeof error !== "object" || error === null || !("issues" in error)) return null;
  const raw: unknown = (error as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return null;
  return raw.map((entry: unknown) => (entry ?? {}) as ZodIssueLike);
}

function labelOf(path: unknown, entity: string): string {
  if (!Array.isArray(path) || path.length === 0) return entity;
  const head: unknown = path[0];
  if (typeof head === "string") return FIELD_LABELS[head] ?? head;
  if (typeof head === "number") return path.join(".");
  return entity;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item: unknown) => String(item)) : [];
}

/** 单条 Zod issue -> 一句中文。落在无法识别的分支时保留原始 message，不吞信息。 */
function issueText(issue: ZodIssueLike, entity: string): string {
  const label = labelOf(issue.path, entity);
  if (issue.code === "invalid_type") {
    return issue.received === "undefined" ? `${label}必填` : `${label}需要用正确的类型填写`;
  }
  if (issue.code === "too_small") {
    return issue.type === "string" && issue.minimum === 1
      ? `${label}必填`
      : `${label}不能小于 ${String(issue.minimum)}`;
  }
  if (issue.code === "too_big") return `${label}超出允许范围（上限 ${String(issue.maximum)}）`;
  if (issue.code === "invalid_enum_value") {
    return `${label}不合法，可选值：${stringList(issue.options).join(" / ")}`;
  }
  if (issue.code === "invalid_string") {
    return issue.validation === "email" ? `${label}不是合法邮箱` : `${label}格式不正确`;
  }
  if (issue.code === "unrecognized_keys")
    return `不支持的字段：${stringList(issue.keys).join("、")}`;
  return `${label}：${typeof issue.message === "string" ? issue.message : "校验失败"}`;
}

function toIssueSummaries(issues: ZodIssueLike[]): ZodIssueSummary[] {
  return issues.map((issue) => ({
    path: Array.isArray(issue.path)
      ? issue.path.map((segment: unknown): string | number =>
          typeof segment === "number" || typeof segment === "string" ? segment : "",
        )
      : [],
    code: typeof issue.code === "string" ? issue.code : "invalid",
    message: typeof issue.message === "string" ? issue.message : "",
  }));
}

export interface WriteErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    issues?: ZodIssueSummary[];
    reason?: string;
  };
}

/**
 * 校验失败 -> 400，body 里是可读的中文原因 + 结构化 issues。
 * `entity` 用于 path 为空（整个 body 不是对象）时的兜底主语，如「客户」。
 */
export function invalidInputException(error: unknown, entity: string): HttpException | null {
  const issues = zodIssuesOf(error);
  if (!issues) return null;
  const body: WriteErrorBody = {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: issues.map((issue) => issueText(issue, entity)).join("；"),
      issues: toIssueSummaries(issues),
    },
  };
  return new HttpException(body, 400);
}

/**
 * 内核拒绝 -> 409（重复）/ 404（找不到）/ 400（其它业务拒绝）。
 * 返回 null 表示这不是内核错误，调用方继续向上抛（未知异常仍是 500）。
 */
export function kernelErrorException(error: unknown): HttpException | null {
  if (!isKernelError(error)) return null;
  const reason = error.details.reason;
  const status =
    error.code === "CUSTOMER_NOT_FOUND" || error.code === "RESOURCE_NOT_FOUND"
      ? 404
      : error.code === "PERMISSION_DENIED"
        ? 403
        : reason === "CUSTOMER_NAME_EXISTS" ||
            reason === "CUSTOMER_CODE_EXISTS" ||
            reason === "SAMPLE_CODE_EXISTS"
          ? 409
          : 400;
  const body: WriteErrorBody = {
    ok: false,
    error: { code: reason ?? error.code, message: error.message, reason },
  };
  return new HttpException(body, status);
}

/**
 * 把录入异常翻译成 HTTP 错误；不认识的异常原样抛出（不把真正的 500 伪装成 400）。
 */
export function writeException(error: unknown, entity: string): HttpException {
  const invalid = invalidInputException(error, entity);
  if (invalid) return invalid;
  const kernel = kernelErrorException(error);
  if (kernel) return kernel;
  throw error;
}
