import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import type { IntentListResponse, SubmitIntentResult } from "@weave-order/schema";
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new BadRequestException("limit 必须是数字");
  return parsed;
}

/**
 * 意图通道 HTTP 面。
 *
 * 只做请求编排：状态机、幂等、审计全部在 kernel.intent 里。
 * 提交永远返回真实落库的状态（当前执行器未接入 = QUEUED + NOT_CONNECTED），
 * 控制器不负责把任何失败包装成成功。
 */
@Controller("api")
export class IntentController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Post("intents")
  @HttpCode(202)
  async submit(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<SubmitIntentResult> {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.intent.submit(body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("intents")
  async list(
    @Query("limit") limit?: string,
    @Headers("authorization") authorization?: string,
  ): Promise<IntentListResponse> {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel) => ({ items: await kernel.intent.list(parseLimit(limit)) }),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("intents/:id")
  async detail(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel) => ({ intent: await kernel.intent.get(id) }),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("intents/:id/cancel")
  @HttpCode(200)
  async cancel(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({ intent: await kernel.intent.cancel(id, ctx) }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }
}
