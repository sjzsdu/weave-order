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
import { OnboardingService, StartTenantConflict, TeamActionError } from "./onboarding.service";

function fail(status: number, code: string, message: string): HttpException {
  return new HttpException(ApiErrorResponse.parse({ error: { code, message } }), status);
}

function toHttpError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof TeamActionError) {
    return fail(error.status, error.status === 403 ? "FORBIDDEN" : "INVALID_INPUT", error.message);
  }
  if (error instanceof StartTenantConflict) {
    return fail(HttpStatus.CONFLICT, "CONFLICT", error.message);
  }
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

  /**
   * 老板自助创建公司：登录即可，不用等平台发链接。
   * 一个账号一间公司；重复调用返回已经建好的那间。
   */
  @Post("start")
  async start(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<OnboardingResult> {
    try {
      const claims = await this.auth.verifyClaims(authorization);
      return await this.onboarding.start(claims, body);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  /** 员工打开邀请链接：先确认是哪家公司、什么角色，再决定接受。 */
  @Get("invite/preview")
  async previewInvite(
    @Headers("authorization") authorization: string | undefined,
    @Query("code") code?: string,
  ) {
    try {
      const claims = await this.auth.verifyClaims(authorization);
      if (!code) throw new TeamActionError("缺少邀请链接，请从消息里重新打开", 400);
      return await this.onboarding.previewInvite(code, claims);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  /** 接受邀请：登录身份绑定到公司，成为正式成员。 */
  @Post("invite/accept")
  async acceptInvite(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<OnboardingResult> {
    try {
      const claims = await this.auth.verifyClaims(authorization);
      const input = OnboardingClaimInput.parse(body);
      return await this.onboarding.acceptInvite(input.code, claims);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}

/**
 * 团队：邀请同事、看待接受名单。
 *
 * 与开通用的是同一套票据：区别只是 `kind: "invite"`，打开后加入已有公司而不是建新公司。
 */
@Controller("api/team")
export class TeamController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
  ) {}

  @Get("invites")
  async list(@Headers("authorization") authorization?: string) {
    try {
      const { membership } = await this.auth.authenticate(authorization);
      return await this.onboarding.listTeam(membership.tenantId);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Post("invites")
  async invite(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    try {
      const { membership } = await this.auth.authenticate(authorization);
      return await this.onboarding.invite(membership, body);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
