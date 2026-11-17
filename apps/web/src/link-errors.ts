import { ApiError } from "@weave-order/core";

/**
 * 链接类页面（邀请 / 开通 / 自助开公司）的错误话术。
 *
 * 服务端 4xx 的 `message` 已经是给人看的中文，可以直接展示；但 401 / 5xx /
 * 网络异常背后是「会话过期」「Invalid Compact JWS」这类技术串，一律换成人话。
 * 这里只负责挑选文案，不吞错误：调用方仍会把真实 cause 打到控制台。
 */
const TECHNICAL =
  /compact jws|jws|jwt|bearer|session:|token|econn|fetch failed|http \d{3}|\[object |undefined|null|[0-9a-f]{8}-[0-9a-f]{4}/i;

/** 可以直接展示给用户的业务错误：400 参数、403 权限、409 冲突、410 失效。 */
const BUSINESS_STATUSES = new Set([400, 403, 404, 409, 410]);

export function linkErrorCopy(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) {
      return "登录已过期，请重新登录后再打开这条链接。";
    }
    if (BUSINESS_STATUSES.has(cause.status)) {
      const message = cause.message.trim();
      return message && !TECHNICAL.test(message) ? message : fallback;
    }
    if (cause.status >= 500) {
      return "服务暂时不可用，请稍后重试。";
    }
    return fallback;
  }
  return fallback;
}
