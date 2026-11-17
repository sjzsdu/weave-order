/**
 * 上传失败的统一表达。
 *
 * 浏览器里的 CORS / 断网都会让 `fetch` 抛 TypeError，没有状态码；
 * 如果调用方只看 `network.online`，就会把「上传失败」误报成「离线已存本地」。
 * 所有直传失败都收敛成 MediaUploadError，页面据此给出可重试的中文提示。
 */
export type UploadFailureKind = "network" | "http" | "storage";

export class MediaUploadError extends Error {
  readonly kind: UploadFailureKind;
  readonly status?: number;

  constructor(
    message: string,
    kind: UploadFailureKind,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "MediaUploadError";
    this.kind = kind;
    this.status = options.status;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isMediaUploadError(error: unknown): error is MediaUploadError {
  return error instanceof MediaUploadError;
}

/** 对象存储返回非 2xx：403/401 多半是桶权限或 CORS 规则，提示要指向运维而不是让用户干瞪眼。 */
export function uploadHttpError(status: number): MediaUploadError {
  if (status === 401 || status === 403) {
    return new MediaUploadError(
      `图片上传失败（HTTP ${status}）：存储服务拒绝写入，请联系管理员检查存储桶 CORS 与权限`,
      "http",
      { status },
    );
  }
  return new MediaUploadError(`图片上传失败（HTTP ${status}），请重试`, "http", { status });
}

/** 把 fetch / Taro 抛出的原始异常转成面向用户的错误；原始异常留在 cause 里便于排查。 */
export function toMediaUploadError(
  error: unknown,
  fallback = "图片上传失败，请重试",
): MediaUploadError {
  if (isMediaUploadError(error)) return error;
  if (error instanceof TypeError) {
    return new MediaUploadError(
      "图片上传失败：无法连接存储服务（网络异常或跨域限制），请重试",
      "network",
      { cause: error },
    );
  }
  if (error instanceof Error && error.message.trim()) {
    return new MediaUploadError(error.message, "storage", { cause: error });
  }
  return new MediaUploadError(fallback, "storage", { cause: error });
}

/** 页面展示用文案：已知错误原样使用，未知错误退回到调用方给的兜底句。 */
export function uploadFailureMessage(error: unknown, fallback = "图片上传失败，请重试"): string {
  if (isMediaUploadError(error)) return error.message;
  if (error instanceof TypeError) return toMediaUploadError(error).message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/**
 * 建样品是「先建记录、后传图」，传图失败必须回滚，否则会留下无图样品。
 * 回滚成功与失败要给不同的下一步，不能都说「请重试」。
 */
export function buildSampleSaveFailureMessage(input: {
  reason: string;
  rolledBack: boolean;
  name: string;
  code: string;
}): string {
  if (input.rolledBack) {
    return `建样品失败：${input.reason}。本次样品记录已撤销，照片还在本页，可重试。`;
  }
  return `建样品失败：${input.reason}。样品「${input.name}」可能已创建（${input.code}），请到样品库确认后补图。`;
}
