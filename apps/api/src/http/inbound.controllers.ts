import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Post,
  Query,
} from "@nestjs/common";
import { InboundReplyList } from "@weave-order/schema";
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import { InboundIntakeService } from "./inbound-intake.service";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

/**
 * 手工录入客户回复的 HTTP 面。
 *
 * 只有两个动作：录入（含识别 / 可选生成报价草稿）和按客户读取最近记录。
 * 截图先走 `/api/media/presign`（purpose=inbound）直传，这里只收 objectKey。
 */
@Controller("api/inbound")
export class InboundController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(InboundIntakeService) private readonly intake: InboundIntakeService,
  ) {}

  @Post("replies")
  async create(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        (kernel, ctx) => this.intake.run(kernel, ctx, body),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("replies")
  async list(
    @Query("customerId") customerId: string | undefined,
    @Query("limit") limit: string | undefined,
    @Headers("authorization") authorization?: string,
  ) {
    if (!customerId) {
      throw new BadRequestException("缺少 customerId");
    }
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          await kernel.customers.getById(customerId, ctx);
          const messages = await kernel.inboundReplies.listByCustomer(
            customerId,
            limit ? Number(limit) : 20,
          );
          return InboundReplyList.parse({ messages });
        },
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }
}
