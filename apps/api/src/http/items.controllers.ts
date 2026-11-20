import {
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
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

/**
 * 业务事项 HTTP 面（P0a）。
 *
 * 所有写动作都经 `HumanActorService` 打开租户作用域，actor 由登录态注入；
 * 状态机与「完成必须有业务结果」的校验在 kernel，不在控制器。
 */
@Controller("api")
export class ItemController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get("items")
  async list(
    @Query("status") status?: string,
    @Query("filter") filter?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) =>
          kernel.items.list(
            {
              ...(status ? { status } : {}),
              ...(filter ? { filter } : {}),
              ...(cursor ? { cursor } : {}),
              ...(limit ? { limit: Number(limit) } : {}),
            },
            ctx,
          ),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("items")
  async create(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.items.create(body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("items/:id")
  async detail(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel) => kernel.items.getById(id),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("items/:id/transition")
  @HttpCode(200)
  async transition(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.items.transition(id, body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("items/:id/complete")
  @HttpCode(200)
  async complete(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.items.complete(id, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  /** 事项下的报价版本（同一事项可以有多份，直到其中一份被确认）。 */
  @Get("items/:id/quotes")
  async quotes(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel) => kernel.quotes.listForItem(id),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  /** 在事项里发起报价：走现有报价工具链（建议价 + 生成草稿），草稿绑定 itemId。 */
  @Post("items/:id/quotes")
  @HttpCode(201)
  async createQuote(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.quotes.createForItem(id, body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }
}
