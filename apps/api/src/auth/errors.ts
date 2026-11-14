import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch } from "@nestjs/common";
import type { AuthErrorCode } from "@weave-order/schema";

/**
 * 凭据错误：HTTP 层与 CLI 共用的封闭语义。
 *
 * 不用字符串拼错误消息，而是让 `code` 成为可判别键：
 * CLI 据此决定是提示重新登录（TOKEN_EXPIRED / TOKEN_REVOKED）、
 * 申请更高权限（SCOPE_REQUIRED），还是直接报错。
 */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly status: number = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const STATUS_BY_CODE: Partial<Record<AuthErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  SCOPE_REQUIRED: 403,
  TENANT_REQUIRED: 403,
  TENANT_UNAVAILABLE: 403,
  NO_MEMBERSHIP: 403,
  INVALID_USER_CODE: 404,
  USER_CODE_EXPIRED: 410,
  DEVICE_CODE_INVALID: 400,
};

export function authError(code: AuthErrorCode, message: string): AuthError {
  return new AuthError(code, message, STATUS_BY_CODE[code] ?? 400);
}

/** 只依赖用得到的两个方法，避免把 express 的类型带进依赖面。 */
interface ErrorResponse {
  status(code: number): ErrorResponse;
  json(body: unknown): void;
}

/** 把 AuthError 映射成稳定的 JSON 错误体：`{ error: { code, message } }`。 */
@Catch(AuthError)
export class AuthErrorFilter implements ExceptionFilter<AuthError> {
  catch(exception: AuthError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ErrorResponse>();
    response.status(exception.status).json({
      error: { code: exception.code, message: exception.message },
    });
  }
}
