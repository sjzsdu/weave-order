import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "../gateway/auth.service";
import type { TokenScope } from "@weave-order/schema";
import type { KernelContext } from "../kernel";
import { AGENT_CONTEXT } from "./context";

/**
 * 工具调用的身份与作用域。
 *
 * 工具永远以 AGENT 身份产出草稿，但「是谁驱动了 agent」要可追溯：
 * - 带 Bearer（OIDC 或 PAT）：先认证，PAT 必须有 `write` 作用域，
 *   审计 actorId 记 `user:<subject>`，tenantId 取 membership 的租户；
 * - 不带 Bearer：保持本地/演示的匿名 AGENT 行为（生产由网关 fail-closed 兜底）。
 */
@Injectable()
export class AgentActorService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async context(
    authorization: string | undefined,
    scope: Extract<TokenScope, "read" | "write"> = "write",
  ): Promise<KernelContext> {
    if (!authorization) return AGENT_CONTEXT;

    let identity;
    try {
      identity = await this.auth.authenticate(authorization);
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "认证失败");
    }

    if (identity.tokenScopes && !identity.tokenScopes.includes(scope)) {
      throw new ForbiddenException({
        error: {
          code: "SCOPE_REQUIRED",
          message: `当前凭据缺少 ${scope} 作用域，不能调用该工具`,
        },
      });
    }

    return {
      actor: {
        type: "AGENT",
        id: `user:${identity.membership.subject}`,
        role: identity.membership.role,
      },
      tenantId: identity.membership.tenantId,
    };
  }
}
