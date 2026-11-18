/**
 * 控制面 / BFF 返回的错误 → 用户能执行的中文提示。
 *
 * 契约（平台侧 PlatformErrorFilter）：
 *   { error: { code, message, issues?: [{path, code, message, params?}], requestId? } }
 * 管理端绝不把 `message` 原样透出：Zod 默认文案、`fetch failed`、JSON.parse 原文
 * 对运营同事没有意义，也不知道该改哪里。
 */

export type FieldIssue = {
  path: string;
  code?: string;
  /** 服务端原始文案，仅在能确认是中文业务提示时使用。 */
  message: string;
  params?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: FieldIssue[];
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { issues?: FieldIssue[]; requestId?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = options.issues ?? [];
    this.requestId = options.requestId;
  }
}

export type FormError = {
  /** 表单顶部的主文案，始终是中文、可执行。 */
  message: string;
  /** 字段级错误：label 是「第 2 项 · 月付价格」这类可定位的中文名称。 */
  fields: { label: string; message: string }[];
  requestId?: string;
};

const CODE_MESSAGES: Record<string, string> = {
  INVALID_INPUT: "提交的内容有误，请按下方提示修改后重试",
  BAD_REQUEST: "提交的内容有误，请按下方提示修改后重试",
  UNAUTHENTICATED: "登录状态已失效，请重新登录后再试",
  FORBIDDEN: "当前账号没有执行此操作的权限，请联系平台管理员",
  NOT_FOUND: "要操作的数据不存在或已被删除，请刷新页面后重试",
  CONFLICT: "数据已被其他人修改，请刷新页面确认最新状态后重试",
  APPROVAL_REQUIRED: "该操作需要第二位 owner 审批通过后才能执行",
  ISOLATION_VIOLATION: "该操作触发了租户隔离规则，已被拒绝",
  PLATFORM_UNREACHABLE: "控制面服务暂时不可达，请稍后重试",
  INTERNAL: "服务暂时不可用，请稍后重试",
  RATE_LIMITED: "操作过于频繁，请稍后再试",
  NETWORK: "网络连接失败，请检查网络后重试",
};

/** 控制面/运行时的通用占位文案，不应展示给用户。 */
const GENERIC_MESSAGES = new Set([
  "请求参数校验失败",
  "Invalid input",
  "Bad Request",
  "Unauthorized",
  "Forbidden",
  "Not Found",
  "Conflict",
  "Internal Server Error",
  "fetch failed",
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
]);

const FIELD_LABELS: Record<string, string> = {
  name: "名称",
  slug: "短标识（slug）",
  contactName: "联系人",
  contactEmail: "联系邮箱",
  planCode: "套餐",
  planName: "套餐名称",
  seats: "席位数",
  billingCycle: "账期",
  isolationMode: "隔离模式",
  region: "区域",
  trialDays: "试用天数",
  notes: "备注",
  description: "说明",
  prices: "价格表",
  monthlyPriceCents: "月付价格",
  annualPriceCents: "年付价格",
  currency: "币种",
  key: "Key（唯一标识）",
  scope: "作用域",
  scopeRef: "作用域引用",
  value: "配置值",
  monthlyTotalCents: "月费",
  annualTotalCents: "年费",
  effectiveMonthlyCents: "折算月费",
  provider: "Provider",
  baseUrl: "网关地址",
  defaultModel: "默认模型",
  dailyTokenBudget: "日 token 预算",
  monthlyTokenBudget: "月 token 预算",
  keyRef: "Key 引用",
  tenantId: "租户",
  ticketNo: "工单号",
  reason: "原因",
  title: "标题",
  body: "描述",
  status: "状态",
  invoiceType: "发票类型",
  taxRateBp: "税率",
  priceDisplay: "价格展示",
  issuerEntity: "开票主体",
  issueTiming: "开票时机",
  redFlushRule: "红冲规则",
  mfaRequired: "强制 MFA",
  ssoEnabled: "企业 SSO",
  casdoorOrgTemplate: "Casdoor 组织模板",
  sessionMaxHours: "会话最长时长",
  enabled: "开关",
  rolloutPercent: "灰度比例",
  tenantIds: "租户范围",
  resource: "资源",
  tenantConsent: "租户同意",
};

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

/** 把 `prices.0.monthlyPriceCents` 这类路径转成「价格表第 1 项 · 月付价格」。 */
export function fieldLabel(path: string | string[]): string {
  const raw = Array.isArray(path) ? path.join(".") : path;
  const parts = raw.split(".").filter(Boolean);
  if (parts.length === 0) return "请求内容";
  const indexAt = parts.findIndex((part) => /^\d+$/.test(part));
  const groupKey = parts.slice(0, indexAt === -1 ? 0 : indexAt).pop();
  const group = groupKey ? (FIELD_LABELS[groupKey] ?? humanizeKey(groupKey)) : "";
  const ordinal = indexAt === -1 ? "" : `第 ${Number(parts[indexAt]) + 1} 项`;
  const keys = indexAt === -1 ? parts : parts.slice(indexAt + 1);
  // 数组项自身的错误（如 prices.0）没有更末级的 key，避免输出「价格表 第 1 项 价格表」。
  if (keys.length === 0) return [group, ordinal].filter(Boolean).join(" ") || "请求内容";
  const leafKey = keys[keys.length - 1] ?? groupKey ?? "";
  const leaf = FIELD_LABELS[leafKey] ?? humanizeKey(leafKey);
  return [group, ordinal, leaf].filter(Boolean).join(" ") || "请求内容";
}

function looksEnglish(message: string): boolean {
  return /^[\x20-\x7e]+$/.test(message.trim());
}

function paramText(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** 把单条 Zod issue 转成中文、带修复动作的字段提示。 */
export function describeIssue(issue: FieldIssue): string {
  const params = issue.params ?? {};
  switch (issue.code) {
    case "invalid_type":
      return params.received === "undefined" || params.received === "null"
        ? "请填写"
        : "格式不正确";
    case "too_small": {
      const min = paramText(params.minimum);
      if (params.type === "string") return min ? `至少需要 ${min} 个字符` : "长度不足";
      if (params.type === "array") return min ? `至少需要 ${min} 项` : "项数不足";
      if (!min) return "数值过小";
      return params.inclusive === false ? `必须大于 ${min}` : `不能小于 ${min}`;
    }
    case "too_big": {
      const max = paramText(params.maximum);
      if (params.type === "string") return max ? `不能超过 ${max} 个字符` : "长度超出限制";
      if (params.type === "array") return max ? `最多 ${max} 项` : "项数超出限制";
      if (!max) return "数值过大";
      return params.inclusive === false ? `必须小于 ${max}` : `不能大于 ${max}`;
    }
    case "invalid_enum_value": {
      const options = Array.isArray(params.options)
        ? params.options
            .map(paramText)
            .filter((option): option is string => Boolean(option))
            .join(" / ")
        : "";
      return options ? `请选择有效选项：${options}` : "请选择有效选项";
    }
    case "invalid_string": {
      switch (params.validation) {
        case "email":
          return "请输入有效的邮箱地址";
        case "url":
          return "请输入有效的网址（以 http:// 或 https:// 开头）";
        case "uuid":
          return "ID 格式不正确";
        case "regex":
          return "格式不正确";
        default:
          return "格式不正确";
      }
    }
    case "unrecognized_keys":
      return "包含不支持的字段";
    case "invalid_union":
    case "invalid_literal":
      return "格式不正确";
    default:
      // 自定义 refine 一般是中文业务文案（「价格不能为负」等），原样保留；
      // Zod 默认英文文案一律换成可执行提示，避免英文技术文案出现在中文界面。
      return issue.message && !looksEnglish(issue.message) ? issue.message : "格式不正确";
  }
}

function isFriendlyServerMessage(message: string | undefined): message is string {
  if (!message) return false;
  const trimmed = message.trim();
  if (!trimmed || GENERIC_MESSAGES.has(trimmed)) return false;
  if (!/[\u4e00-\u9fff]/.test(trimmed)) return false;
  // 中文里夹带底层实现细节时同样不展示（例如「JSON.parse ... at position 1」）。
  return !/\b(json|zod|sql|econn|fetch|stack|undefined|position \d+)\b/i.test(trimmed);
}

/**
 * 任何异常 → 可展示的 FormError。
 * 未知错误只给通用中文文案 + 请求编号，原始信息留给浏览器控制台排障。
 */
export function toFormError(cause: unknown): FormError {
  if (cause instanceof ApiError) {
    const main = isFriendlyServerMessage(cause.message)
      ? cause.message.trim()
      : (CODE_MESSAGES[cause.code] ??
        (cause.status >= 500 ? "服务暂时不可用，请稍后重试" : "操作失败，请检查填写内容后重试"));
    const fields = cause.issues
      .slice(0, 12)
      .map((issue) => ({ label: fieldLabel(issue.path), message: describeIssue(issue) }))
      .filter(
        (field, index, all) =>
          all.findIndex((item) => item.label === field.label && item.message === field.message) ===
          index,
      );
    const requestId = cause.requestId;
    // 请求编号只在无法自助恢复的错误上展示，避免普通校验提示被编号干扰。
    const showRequestId = Boolean(requestId) && (cause.status >= 500 || !CODE_MESSAGES[cause.code]);
    return {
      message: showRequestId && requestId ? `${main}（请求编号 ${requestId.slice(0, 8)}）` : main,
      fields,
      requestId,
    };
  }
  if (
    cause instanceof TypeError ||
    (cause instanceof Error && /fetch failed|NetworkError/i.test(cause.message))
  ) {
    return { message: CODE_MESSAGES.NETWORK ?? "网络连接失败，请检查网络后重试", fields: [] };
  }
  return { message: "操作失败，请稍后重试", fields: [] };
}

/** 兼容旧调用点：只要一句主文案时使用。 */
export function toErrorMessage(cause: unknown): string {
  return toFormError(cause).message;
}
