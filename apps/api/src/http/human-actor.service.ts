import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { AuthClaims, Membership } from "@weave-order/schema";
import { AuthService } from "../gateway/auth.service";
import type { Kernel, KernelContext } from "../kernel";
import { humanScopeOf } from "../kernel/data-scope";
import { isProductionLike } from "../platform/runtime-mode";

/**
 * 本地/演示的人类上下文。
 * 只有非生产态（NODE_ENV≠production 且 AUTH_MODE≠oidc）且请求没有 Bearer 令牌时才会使用；
 * 生产态缺令牌直接 401，绝不静默按 OWNER 运行。
 */
export const DEV_HUMAN_CONTEXT: KernelContext = {
  actor: { type: "HUMAN", id: "web-approver", role: "OWNER" },
  // 本地演示/既有集成测试没有真实成员记录，按全租户可见，避免把演示数据全部隐藏。
  dataScope: "ALL",
  ownerId: null,
  teamId: null,
};

/**
 * 把登录态转成内核可用的 HUMAN 上下文 + 租户作用域内核。
 *
 * 生产路径：
 *   Authorization → AuthService.verify → membership.role → KernelContext.actor.role
 * 并用 `openScope` 打开该租户的 RLS 会话，审批 / 改稿 / 收款都写在正确租户里。
 *
 * 本地路径（无令牌、非生产态）：回退固定 OWNER 并复用默认租户内核，
 * 仅用于 demo / 既有集成测试，不进入生产。
 */
@Injectable()
export class HumanActorService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async run<T>(
    authorization: string | undefined,
    fallbackKernel: Kernel,
    fn: (kernel: Kernel, ctx: KernelContext) => Promise<T>,
  ): Promise<T> {
    if (authorization) {
      let claims: AuthClaims;
      let membership: Membership;
      try {
        ({ claims, membership } = await this.auth.authenticate(authorization));
      } catch (error) {
        throw new UnauthorizedException(error instanceof Error ? error.message : "认证失败");
      }
      if (membership.status !== "ACTIVE") {
        throw new ForbiddenException("成员身份未启用");
      }
      const scope = await this.auth.openScope(membership);
      try {
        const ctx: KernelContext = {
          actor: {
            type: "HUMAN",
            id: claims.sub,
            role: membership.role,
            approvalLimitAmount: membership.approvalLimitAmount,
          },
          // 应用层数据范围：RLS 之外的第二道闸，读路径统一按它过滤。
          ...humanScopeOf(membership),
        };
        return await fn(scope.kernel, ctx);
      } finally {
        await scope.release();
      }
    }

    if (isProductionLike()) {
      throw new UnauthorizedException("缺少 Bearer 令牌");
    }
    return fn(fallbackKernel, DEV_HUMAN_CONTEXT);
  }
}
