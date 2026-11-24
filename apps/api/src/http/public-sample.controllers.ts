import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Ip,
  Param,
} from "@nestjs/common";
import { QuoteLinkError } from "../kernel";
import { PublicRateLimitService } from "../platform/rate-limit";
import type { PublicSampleCardService } from "../kernel/public-sample-card.service";
import { PUBLIC_RATE_LIMIT, PUBLIC_SAMPLE } from "./tokens";

function clientIp(ip: string | undefined, forwarded: string | undefined): string | undefined {
  return forwarded?.split(",")[0]?.trim() || ip;
}

/**
 * 样卡二维码的公开路由（无登录、无 Cookie）。
 *
 * 只回 `PublicSampleCard` 允许的两个字段；扫码页不写库、不埋点、不读业务表以外的数据。
 */
@Controller("api/public/sample-cards")
export class PublicSampleCardController {
  constructor(
    @Inject(PUBLIC_SAMPLE) private readonly cards: PublicSampleCardService,
    @Inject(PUBLIC_RATE_LIMIT) private readonly limits: PublicRateLimitService,
  ) {}

  @Get(":token")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  @Header("X-Robots-Tag", "noindex, nofollow")
  async view(
    @Param("token") token: string,
    @Ip() ip: string | undefined,
    @Headers("x-forwarded-for") forwarded?: string,
  ) {
    const denial = await this.limits.checkPublicSample(clientIp(ip, forwarded), token);
    if (denial) {
      throw new HttpException(
        {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "请求过于频繁，请稍后再试",
            retryAfterSeconds: denial.retryAfterSeconds,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return { ok: true, data: await this.cards.view(token) };
    } catch (error) {
      if (error instanceof QuoteLinkError) {
        throw new HttpException(
          { ok: false, error: { code: error.code, message: error.message } },
          HttpStatus.NOT_FOUND,
        );
      }
      throw error;
    }
  }
}
