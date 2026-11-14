import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
} from "@nestjs/common";
import { ApiErrorResponse, OnboardingClaimInput } from "@weave-order/schema";
import type { OnboardingPreview, OnboardingResult } from "@weave-order/schema";
import { AuthService } from "../gateway/auth.service";
import { isKernelError } from "../kernel";
import { OnboardingTicketError } from "./ticket";
import { OnboardingService } from "./onboarding.service";

function fail(status: number, code: string, message: string): HttpException {
  return new HttpException(ApiErrorResponse.parse({ error: { code, message } }), status);
}

function toHttpError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof OnboardingTicketError) {
    // 410：链接过期或内容已失效，前端据此提示「向对接人要一条新的」。
    // 契约里 error.code 是固定枚举，这里用 INVALID_INPUT + 410 表达「这条链接不再可用」。
    return fail(HttpStatus.GONE, "INVALID_INPUT", error.message);
  }
  if (isKernelError(error)) {
    if (error.code === "PERMISSION_DENIED")
      return fail(HttpStatus.FORBIDDEN, "FORBIDDEN", error.message);
    return fail(HttpStatus.CONFLICT, "CONFLICT", error.message);
  }
  return fail(
    HttpStatus.UNAUTHORIZED,
    "UNAUTHENTICATED",
    error instanceof Error ? error.message : "认证失败",
  );
}

/**
 * 开通链接的领取入口。
 *
 * 与其它业务接口的区别：这里只验令牌、不要求已有 membership——
 * 新老板第一次进来时本来就还没有成员身份。领取成功后，同一账号再访问
 * 业务接口就会正常解析到新租户。
 */
@Controller("api/onboarding")
export class OnboardingController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
  ) {}

  @Get("preview")
  async preview(
    @Headers("authorization") authorization?: string,
    @Query("code") code?: string,
  ): Promise<OnboardingPreview> {
    try {
      const claims = await this.auth.verifyClaims(authorization);
      if (!code) throw new OnboardingTicketError("缺少开通链接，请从消息里重新打开");
      return await this.onboarding.preview(code, claims);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Post("claim")
  async claim(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<OnboardingResult> {
    try {
      const claims = await this.auth.verifyClaims(authorization);
      const input = OnboardingClaimInput.parse(body);
      return await this.onboarding.claim(input.code, claims);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
