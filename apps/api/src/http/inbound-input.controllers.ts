import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import type { InboundDetail, SubmitInboundResult } from "@weave-order/schema";
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import { InboundExecutorService } from "./inbound-executor.service";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

/**
 * 统一输入 HTTP 面（P0a-3）。
 *
 * 与 `InboundController`（客户回复录入）共用 `api/inbound` 前缀，但路由不重叠：
 * - `POST /api/inbound`            提交一段话 + 附件，返回可轮询的 inboundId；
 * - `GET  /api/inbound/:id`         理解卡与任务进度；
 * - `POST /api/inbound/:id/start`   用户确认后执行；
 * - `POST /api/inbound/:id/revise`  纠正 kind / 槽位 / 字段后重新整理。
 *
 * 提交与执行都不在请求里等模型：理解/执行由后台执行器推进，前端轮询同一个 id。
 */
@Controller("api/inbound")
export class InboundInputController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(InboundExecutorService) private readonly executor: InboundExecutorService,
  ) {}

  @Post()
  @HttpCode(202)
  async submit(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<SubmitInboundResult> {
    try {
      const { result, created, status } = await this.human.run(
        authorization,
        this.kernel,
        async (
          kernel,
          ctx,
        ): Promise<{ result: SubmitInboundResult; created: boolean; status: string }> => {
          const submitted = await kernel.inbound.submit(body, ctx);
          return {
            result: {
              inboundId: submitted.inboundId,
              status: submitted.status,
              intent: submitted.intent,
            },
            created: submitted.created,
            status: submitted.status,
          };
        },
        { scope: "write" },
      );
      if (created && status === "QUEUED") {
        this.executor.startUnderstanding(authorization, result.inboundId);
      }
      return result;
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get(":id")
  async detail(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel): Promise<InboundDetail> => kernel.inbound.getDetail(id),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post(":id/revise")
  @HttpCode(200)
  async revise(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel) => kernel.inbound.revise(id, body),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post(":id/start")
  @HttpCode(202)
  async start(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<InboundDetail> {
    try {
      const detail = await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.inbound.start(id, body, ctx),
        { scope: "write" },
      );
      this.executor.startExecution(authorization, id);
      return detail;
    } catch (error) {
      rethrowHttp(error);
    }
  }
}
