/** 控制面领域错误：统一映射为 HTTP 状态，不把内部 SQL 细节透出。 */
export type PlatformErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "APPROVAL_REQUIRED"
  | "ISOLATION_VIOLATION";

export class PlatformError extends Error {
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export function notFound(message: string): PlatformError {
  return new PlatformError("NOT_FOUND", message, 404);
}
export function conflict(message: string): PlatformError {
  return new PlatformError("CONFLICT", message, 409);
}
export function forbidden(message: string): PlatformError {
  return new PlatformError("FORBIDDEN", message, 403);
}
export function invalid(message: string): PlatformError {
  return new PlatformError("INVALID_INPUT", message, 400);
}
export function approvalRequired(message: string): PlatformError {
  return new PlatformError("APPROVAL_REQUIRED", message, 409);
}
