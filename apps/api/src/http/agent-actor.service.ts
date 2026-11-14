import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Kernel } from "../kernel";
import type { KernelContext } from "../kernel";
import { isProductionLike } from "../platform/runtime-mode";
import { createTools } from "../tools";
import type { Tools } from "../tools";
import { AuthService } from "../gateway/auth.service";
import { humanScopeOf } from "../kernel/data-scope";
import type { TokenScope } from "@weave-order/schema";
import { AGENT_CONTEXT } from "./context";

/**
 * 工具调用的身份与租户会话。
 *
 * 工具永远以 AGENT 身份产出草稿，但「是谁驱动了 agent」要可追溯：
 * - 带 Bearer（OIDC 或 PAT）：先认证，PAT 必须有对应作用域，
 *   审计 actorId 记 `user:<subject>`，并像 `HumanActorService` 那样
 *   用 `openScope` 开一条绑定该租户的会话内核（铁律 G4）——
 *   工具读写与审计落库的 tenantId 由这条会话决定，而不是构造期固化的默认租户；
 * - 不带 Bearer：仅本地/演示的匿名 AGENT 行为，复用默认租户内核；
 *   生产态直接 401，绝不静默按演示租户写账本。
 *
 * 数据范围同样跟驱动者走：agent 只是执行体，不能替调用者放大可见范围，
 * 否则 OWN 成员可以借 `POST /api/tools/*` 读到同事名下的客户（租户内越权）。
 */
@Injectable()
export class AgentActorService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async run<T>(
    authorization: string | undefined,
    fallbackKernel: Kernel,
    fn: (tools: Tools, ctx: KernelContext) => Promise<T>,
    options: { scope?: Extract<TokenScope, "read" | "write"> } = {},
  ): Promise<T> {
    if (!authorization) {
      if (isProductionLike()) {
        throw new UnauthorizedException("缺少 Bearer 令牌");
      }
      return fn(createTools(fallbackKernel), AGENT_CONTEXT);
    }

    let identity;
    try {
      identity = await this.auth.authenticate(authorization);
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "认证失败");
    }
    if (identity.membership.status !== "ACTIVE") {
      throw new ForbiddenException("成员身份未启用");
    }

    const scope = options.scope ?? "write";
    if (identity.tokenScopes && !identity.tokenScopes.includes(scope)) {
      throw new ForbiddenException({
        error: {
          code: "SCOPE_REQUIRED",
          message: `当前凭据缺少 ${scope} 作用域，不能调用该工具`,
        },
      });
    }

    const tenant = await this.auth.openScope(identity.membership);
    try {
      return await fn(createTools(tenant.kernel), {
        actor: {
          type: "AGENT",
          id: `user:${identity.membership.subject}`,
          role: identity.membership.role,
        },
        tenantId: identity.membership.tenantId,
        ...humanScopeOf(identity.membership),
      });
    } finally {
      await tenant.release();
    }
  }
}
