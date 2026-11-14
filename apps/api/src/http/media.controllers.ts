import { Body, Controller, Headers, Inject, Post } from "@nestjs/common";
import { MediaService } from "../media/media.service";
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL, MEDIA_SERVICE } from "./tokens";

/**
 * 图片上传的 HTTP 面：只有两个动作，没有「列对象」「删对象」等桶操作。
 * 控制器只做鉴权上下文 + 错误映射，租户判断与 key 生成都在 media 层完成。
 */
@Controller("api/media")
export class MediaController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(MEDIA_SERVICE) private readonly media: MediaService,
  ) {}

  @Post("presign")
  async presign(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        (kernel, ctx) => this.media.presign(kernel, body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("confirm")
  async confirm(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        (kernel, ctx) => this.media.confirm(kernel, ctx, body),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }
}
