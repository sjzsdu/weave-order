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
import { SubmitIntentInput } from "@weave-order/schema";
import type { IntentListResponse, IntentView, SubmitIntentResult } from "@weave-order/schema";
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { IntentExecutorService } from "./intent-executor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new BadRequestException("limit 必须是数字");
  return parsed;
}

function asSubmitResult(intent: IntentView): SubmitIntentResult {
  return {
    intentId: intent.id,
    status: intent.status,
    executorState: intent.executorState,
    notice: intent.notice,
    intent,
  };
}

/**
 * 意图通道 HTTP 面。
 *
 * 只做请求编排：状态机、幂等、审计全部在 kernel.intent 里。
 *
 * 提交后立刻进入 RUNNING 并启动报价执行器（WAN-172）：回执是「小织正在整理」，
 * 执行结果（草稿 / 缺信息 / 失败）由执行器写回同一条意图，前端轮询即可。
 * 控制器不负责把任何失败包装成成功。
 */
@Controller("api")
export class IntentController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(IntentExecutorService) private readonly executor: IntentExecutorService,
  ) {}

  @Post("intents")
  @HttpCode(202)
  async submit(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<SubmitIntentResult> {
    try {
      // context 只用来启动执行器；合法性仍由 kernel.intent.submit 统一校验。
      const parsed = SubmitIntentInput.safeParse(body);
      const context = parsed.success ? parsed.data.context : undefined;
      const { result, shouldExecute } = await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx): Promise<{ result: SubmitIntentResult; shouldExecute: boolean }> => {
          const submitted = await kernel.intent.submit(body, ctx);
          // 同幂等键的重复提交：返回原状态，绝不重复执行。
          if (submitted.status !== "QUEUED") return { result: submitted, shouldExecute: false };
          try {
            const running = await kernel.intent.markRunning(submitted.intentId);
            return { result: asSubmitResult(running), shouldExecute: true };
          } catch {
            // 并发重复提交可能已被另一个请求推进到 RUNNING：以库里的真实状态为准。
            // 这里不启动执行器，否则同一次提交会出两份草稿。
            const current = await kernel.intent.get(submitted.intentId);
            return { result: asSubmitResult(current), shouldExecute: false };
          }
        },
        { scope: "write" },
      );
      if (shouldExecute) {
        this.executor.start(authorization, {
          intentId: result.intentId,
          text: result.intent.text,
          context,
        });
      }
      return result;
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
