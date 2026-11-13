import { Controller, Get, Headers, HttpException, HttpStatus, Inject, Query } from "@nestjs/common";
import { ApiErrorResponse } from "@weave-order/schema";
import type { Membership } from "@weave-order/schema";
import { isKernelError } from "../kernel";
import { AuthError } from "../auth/errors";
import { AuthService } from "./auth.service";

function fail(status: number, code: string, message: string): HttpException {
  const body = ApiErrorResponse.parse({ error: { code, message } });
  return new HttpException(body, status);
}

/** 统一把鉴权 / 内核错误映射成契约里的 ApiErrorResponse。 */
function toHttpError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthError) {
    return fail(error.status, error.code, error.message);
  }
  if (isKernelError(error)) {
    if (error.code === "PERMISSION_DENIED") {
      return fail(HttpStatus.FORBIDDEN, "FORBIDDEN", error.message);
    }
    if (error.code === "RESOURCE_NOT_FOUND" || error.code === "CUSTOMER_NOT_FOUND") {
      return fail(HttpStatus.NOT_FOUND, "NOT_FOUND", error.message);
    }
    return fail(HttpStatus.CONFLICT, "CONFLICT", error.message);
  }
  return fail(
    HttpStatus.UNAUTHORIZED,
    "UNAUTHENTICATED",
    error instanceof Error ? error.message : "认证失败",
  );
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

/**
 * 网关认证面。
 *
 * - `GET /api/auth/me`：验证 Casdoor 令牌 + 解析本地 membership，返回租户上下文。
 * - `GET /api/auth/customers`：示例业务端点，证明请求走的是「租户会话 + RLS」，
 *   而不是全局连接。
 */
@Controller("api/auth")
export class AuthController {
  // 显式 token：tsx/esbuild 不产出 design:paramtypes，隐式注入会拿到 undefined。
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get("me")
  async me(@Headers("authorization") authorization?: string) {
    try {
      return await this.auth.me(authorization);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Get("customers")
  async customers(
    @Headers("authorization") authorization?: string,
    @Query("limit") limit?: string,
  ) {
    let membership: Membership;
    try {
      ({ membership } = await this.auth.authenticate(authorization));
    } catch (error) {
      throw toHttpError(error);
    }
    const scope = await this.auth.openScope(membership);
    try {
      const rows = await scope.kernel.customers.list(clampLimit(limit, 20, 100));
      return { customers: rows, tenantId: membership.tenantId };
    } catch (error) {
      throw toHttpError(error);
    } finally {
      await scope.release();
    }
  }
}
