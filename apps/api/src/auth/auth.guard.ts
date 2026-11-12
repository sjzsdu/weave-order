import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { TokenScope } from "@weave-order/schema";
import type { AuthContext } from "./auth.service";
import { AuthService } from "./auth.service";
import { authError } from "./errors";

/** 路由需要的 token 作用域。 */
export const AUTH_SCOPE_KEY = "weave:auth:scope";

export function RequireScope(scope: TokenScope): MethodDecorator & ClassDecorator {
  return SetMetadata(AUTH_SCOPE_KEY, scope);
}

/** Nest 请求对象上由守卫填充的身份。 */
export interface AuthRequest {
  headers: { authorization?: string };
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
  auth?: AuthContext;
}

/**
 * 全局凭据守卫。
 *
 * 语义（与 CLI 的 exit code 对齐）：
 * - 带 Authorization：必须有效，否则 401（INVALID_TOKEN / TOKEN_EXPIRED / TOKEN_REVOKED）；
 * - 要求的 scope 不在 token 里：403（SCOPE_REQUIRED）；
 * - 未带 Authorization：开发环境放行（页面 MVP 仍可匿名只读），
 *   生产环境 / AUTH_REQUIRED=true 时 401（AUTH_REQUIRED）。
 *
 * 匿名放行只是本地开发的降级路径：任何需要身份的端点（/api/auth/*）
 * 会在控制器里显式要求 `req.auth`，不会因为开发模式而失去身份。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  // 显式 @Inject：仓库的测试/开发运行时走 esbuild（不发 decorator metadata），
  // 依赖注入必须靠显式 token 才能拿到实例。
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const requiredScope = this.reflector.getAllAndOverride<TokenScope | undefined>(AUTH_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const identity = await this.auth.authenticate(request.headers.authorization);
    if (!identity) {
      if (this.auth.authRequired) {
        throw authError("AUTH_REQUIRED", "缺少凭据：请执行 weave login 或设置 WEAVE_TOKEN");
      }
      return true;
    }

    request.auth = identity;
    if (requiredScope && !identity.token.scopes.includes(requiredScope)) {
      throw authError(
        "SCOPE_REQUIRED",
        `当前凭据缺少 ${requiredScope} 作用域：请用 weave token create --scope ${requiredScope} 新建凭据`,
      );
    }
    return true;
  }
}

/** 控制器里取「一定存在」的身份；缺失即 401。 */
export function requireAuth(request: AuthRequest): AuthContext {
  if (!request.auth) {
    throw authError("AUTH_REQUIRED", "该接口需要凭据：请执行 weave login 或设置 WEAVE_TOKEN");
  }
  return request.auth;
}
