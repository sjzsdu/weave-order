import { Body, Controller, Get, Headers, Inject, Put } from "@nestjs/common";
import type { OnboardingState } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

/**
 * 成员键：生产是 `memberships.id`（humanScopeOf 注入 ownerId）；
 * 本地演示没有成员记录时回落成 actor id。引导进度不是业务单据，不需要外键。
 */
function memberKey(ctx: KernelContext): string {
  return ctx.ownerId ?? ctx.actor.id;
}

/**
 * 开张清单进度的 HTTP 面。
 *
 * 只做编排：合并规则（首次完成时间不被覆盖、四步齐全才写 allDoneAt）
 * 全部在 `kernel.onboardingState` 里，控制器不自己拼状态。
 */
@Controller("api/onboarding")
export class OnboardingStateController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get("state")
  async get(@Headers("authorization") authorization?: string): Promise<OnboardingState> {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.onboardingState.get(memberKey(ctx)),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Put("state")
  async update(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<OnboardingState> {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.onboardingState.update(memberKey(ctx), body),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }
}
