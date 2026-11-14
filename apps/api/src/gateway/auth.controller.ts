import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiErrorResponse } from "@weave-order/schema";
import type { Membership } from "@weave-order/schema";
import { isKernelError } from "../kernel";
import { AuthError } from "../auth/errors";
import { humanScopeOf } from "../kernel/data-scope";
import { isProductionLike } from "../platform/runtime-mode";
import { AuthService } from "./auth.service";
import { SESSION_COOKIE } from "./session.service";
import { readSessionCookie } from "./session-credential.middleware";

/**
 * 只依赖用得到的两个方法，避免把 express 类型带进依赖面（与 auth/errors.ts 同一策略）。
 */
interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
}

function fail(status: number, code: string, message: string): HttpException {
  const body = ApiErrorResponse.parse({ error: { code, message } });
  return new HttpException(body, status);
}

/** 统一把鉴权 / 内核错误映射成契约里的 ApiErrorResponse。 */
function toHttpError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthError) {
    // 凭据类错误统一折成 UNAUTHENTICATED（CLI 侧另有 AuthErrorFilter 保留细码），
    // 租户类错误保留可判别码，前端据此渲染选择页 / 不可用原因。
    const credentialCodes = new Set([
      "AUTH_REQUIRED",
      "INVALID_TOKEN",
      "TOKEN_EXPIRED",
      "TOKEN_REVOKED",
    ]);
    const code = credentialCodes.has(error.code) ? "UNAUTHENTICATED" : error.code;
    return fail(error.status, code, error.message);
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
 * - `GET /api/auth/me`：验证凭据（会话 / OIDC / PAT）+ 解析租户上下文。
 *   多租户账号在选租户之前返回 `MULTI_TENANT` 列表，而不是拒绝登录。
 * - `GET /api/auth/tenants`：只读「我的公司」列表。
 * - `POST /api/auth/switch`：选择 / 切换租户；`tenantId` 只在这里出现。
 * - `DELETE /api/auth/session`：登出并吊销服务端会话。
 * - `GET /api/auth/customers`：示例业务端点，证明请求走的是「租户会话 + RLS」。
 */
@Controller("api/auth")
export class AuthController {
  // 显式 token：tsx/esbuild 不产出 design:paramtypes，隐式注入会拿到 undefined。
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** 会话 Cookie 的写入策略：httpOnly + SameSite=Lax，生产加 Secure。 */
  private applySession(response: CookieResponse, sid: string | null, ttlSeconds: number): void {
    if (!sid) return;
    response.cookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProductionLike(),
      path: "/",
      maxAge: ttlSeconds * 1000,
    });
  }

  private clearSession(response: CookieResponse): void {
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProductionLike(),
      path: "/",
    });
  }

  @Get("me")
  async me(
    @Headers("authorization") authorization: string | undefined,
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    try {
      const result = await this.auth.me(authorization, readSessionCookie(cookie));
      // 单租户自动进入 / 首次登录都会在这里拿到 sid；浏览器从此不再需要 Casdoor token。
      this.applySession(response, result.sid, this.auth.ttl());
      return result.body;
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Get("tenants")
  async tenants(
    @Headers("authorization") authorization: string | undefined,
    @Headers("cookie") cookie: string | undefined,
  ) {
    try {
      const result = await this.auth.tenants(authorization, readSessionCookie(cookie));
      return result.body;
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Post("switch")
  @HttpCode(200)
  async switch(
    @Headers("authorization") authorization: string | undefined,
    @Headers("cookie") cookie: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    try {
      const result = await this.auth.switchTenant(
        authorization,
        readSessionCookie(cookie),
        body ?? {},
      );
      // 切换会换一把 sid：旧 Cookie 立刻失效，避免两个标签页各自以为是不同租户。
      this.applySession(response, result.sid, this.auth.ttl());
      return result.body;
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Delete("session")
  @HttpCode(204)
  async logout(
    @Headers("authorization") authorization: string | undefined,
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    await this.auth.logout(authorization, readSessionCookie(cookie));
    this.clearSession(response);
  }

  @Get("customers")
  async customers(
    @Headers("authorization") authorization: string | undefined,
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
      const rows = await scope.kernel.customers.list(clampLimit(limit, 20, 100), {
        actor: { type: "HUMAN", id: membership.subject, role: membership.role },
        ...humanScopeOf(membership),
      });
      return { customers: rows, tenantId: membership.tenantId };
    } catch (error) {
      throw toHttpError(error);
    } finally {
      await scope.release();
    }
  }
}
