import { Body, Controller, Get, Headers, Inject, Patch } from "@nestjs/common";
import type { Kernel } from "../kernel";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

/**
 * 租户默认度量单位 HTTP 面。
 *
 * 读与写都由内核校验 `settings.edit`：设置页是管理面，
 * 普通成员不该改公司的默认单位。
 */
@Controller("api/settings")
export class MeasureUnitsController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  /** 当前默认单位（未配置过时给 g/m² 与 cm）。 */
  @Get("measure-units")
  async get(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      ok: true,
      data: await kernel.measureUnits.get(ctx),
    }));
  }

  /** 改默认单位；只影响之后的录入默认值。 */
  @Patch("measure-units")
  async update(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      ok: true,
      data: await kernel.measureUnits.update(body, ctx),
    }));
  }
}
