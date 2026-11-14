import { Controller, Get, Headers, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { ApiErrorResponse } from "@weave-order/schema";
import { AuthService } from "../gateway/auth.service";
import { isKernelError } from "../kernel";

/**
 * 本月 credits 用量。
 *
 * credits 与 token 的换算是 1 credit = 1,000 tokens（输入+输出），
 * 预算落在租户的 LLM 设置里（`monthlyTokenBudget`），达标后智能体暂停、
 * 人仍可查看/审批/导出。这里只读，不改预算。
 */
@Controller("api/usage")
export class CreditsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get("credits")
  async credits(@Headers("authorization") authorization?: string) {
    try {
      const { membership } = await this.auth.authenticate(authorization);
      const scope = await this.auth.openScope(membership);
      try {
        const settings = await scope.kernel.llmSettings.resolve();
        const budget = settings.monthlyTokenBudget;
        const status = await scope.kernel.usage.budgetStatus(settings.dailyTokenBudget, budget);
        const creditsIncluded = budget === null ? null : Math.round(budget / 1000);
        const creditsUsed = Math.round(status.monthlyTokens / 1000);
        const percent =
          creditsIncluded && creditsIncluded > 0
            ? Math.min(100, Math.round((creditsUsed / creditsIncluded) * 100))
            : 0;
        return {
          period: status.period,
          creditsIncluded,
          creditsUsed,
          percent,
          state: percent >= 100 ? "PAUSED" : percent >= 80 ? "WARN" : "OK",
        };
      } finally {
        await scope.release();
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isKernelError(error) && error.code === "PERMISSION_DENIED") {
        throw new HttpException(
          ApiErrorResponse.parse({ error: { code: "FORBIDDEN", message: error.message } }),
          HttpStatus.FORBIDDEN,
        );
      }
      throw new HttpException(
        ApiErrorResponse.parse({
          error: {
            code: "UNAUTHENTICATED",
            message: error instanceof Error ? error.message : "认证失败",
          },
        }),
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
