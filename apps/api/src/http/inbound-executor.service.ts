import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Kernel } from "../kernel";
import type { KernelContext } from "../kernel";
import { EXECUTION_FAILURE_REASON } from "../platform/execution-error";
import { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

/**
 * 统一输入的后台执行器。
 *
 * 两个阶段共用一个执行器：
 * 1. `startUnderstanding`：OCR + 生成理解卡（慢在外部 OCR，HTTP 不等）；
 * 2. `startExecution`：用户确认后建资源草稿/事项（客户/样品按 sourceId 幂等）。
 *
 * 所有异常都必须在内部落库，绝不让 inbound 卡在 RUNNING：
 * 理解失败 → FAILED；执行时缺信息 → NEEDS_INPUT；其余 → FAILED。
 */
@Injectable()
export class InboundExecutorService {
  private readonly logger = new Logger(InboundExecutorService.name);

  constructor(
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(KERNEL) private readonly fallbackKernel: Kernel,
  ) {}

  startUnderstanding(authorization: string | undefined, inboundId: string): void {
    void this.run(authorization, inboundId, async (kernel) => {
      await kernel.inbound.understand(inboundId);
    }).catch((error) => this.fail(authorization, inboundId, error));
  }

  startExecution(authorization: string | undefined, inboundId: string): void {
    void this.run(authorization, inboundId, async (kernel, ctx) => {
      await kernel.inbound.execute(inboundId, ctx);
    }).catch((error) => this.fail(authorization, inboundId, error));
  }

  private async run(
    authorization: string | undefined,
    inboundId: string,
    action: (kernel: Kernel, ctx: KernelContext) => Promise<void>,
  ): Promise<void> {
    await this.human.run(authorization, this.fallbackKernel, async (kernel, ctx) => {
      await action(kernel, ctx);
    });
  }

  private async fail(
    authorization: string | undefined,
    inboundId: string,
    error: unknown,
  ): Promise<void> {
    this.logger.error(
      `统一输入执行失败 inboundId=${inboundId}`,
      error instanceof Error ? error.stack : String(error),
    );
    try {
      await this.human.run(authorization, this.fallbackKernel, async (kernel) => {
        await kernel.intent.markFailed(inboundId, EXECUTION_FAILURE_REASON);
      });
    } catch {
      // 已撤销 / 已超时：保留用户可见的终态，不覆盖。
    }
  }
}
