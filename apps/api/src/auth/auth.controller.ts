import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseFilters,
} from "@nestjs/common";
import {
  ApiTokenList,
  CreateApiTokenInput,
  DeviceAuthorizationDecision,
  DeviceAuthorizationPollInput,
  DeviceAuthorizationStartInput,
  PersonalAccessIdentity,
} from "@weave-order/schema";
import type { TokenScope } from "@weave-order/schema";
import { AuthService } from "../gateway/auth.service";
import type { AuthenticatedIdentity } from "../gateway/auth.service";
import { AuthError, AuthErrorFilter } from "./errors";
import { parseInput } from "./input";
import { PersonalAccessService } from "./personal-access.service";

function unauthenticated(message: string): HttpException {
  return new HttpException(
    { error: { code: "UNAUTHENTICATED", message } },
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * 个人访问凭据 + CLI 设备登录（WAN-78）。
 *
 * 身份来源统一走网关：
 * - OIDC 会话（浏览器 BFF / `/auth/dev`）：人类，无作用域限制，受角色 / RLS 约束；
 * - PAT（`wo_...`）：agent / CLI，按 read / write / approve 作用域收窄。
 *
 * 凭据绑定的是 membership，因此 PAT 认证后仍然落到同一租户、同一 RLS 会话，
 * 不会因为「走 CLI」而绕过租户隔离。
 */
@Controller("api/auth")
@UseFilters(AuthErrorFilter)
export class PersonalAccessController {
  constructor(
    @Inject(AuthService) private readonly gateway: AuthService,
    @Inject(PersonalAccessService) private readonly pat: PersonalAccessService,
  ) {}

  /** 认证并把网关错误统一成 401。AuthError 交给 AuthErrorFilter 保留 code。 */
  private async identify(authorization: string | undefined): Promise<AuthenticatedIdentity> {
    try {
      return await this.gateway.authenticate(authorization);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw unauthenticated(error instanceof Error ? error.message : "认证失败");
    }
  }

  private static requireScope(identity: AuthenticatedIdentity, scope: TokenScope): void {
    if (!identity.tokenScopes) return; // OIDC 人类会话：由角色 / RLS 决定
    if (!identity.tokenScopes.includes(scope)) {
      throw new HttpException(
        {
          error: {
            code: "SCOPE_REQUIRED",
            message: `当前凭据缺少 ${scope} 作用域：请用 weave token create --scope ${scope} 新建凭据`,
          },
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** CLI 自述：凭据（PAT 时返回视图）+ 成员身份 + 租户。 */
  @Get("whoami")
  async whoami(@Headers("authorization") authorization?: string): Promise<PersonalAccessIdentity> {
    const identity = await this.identify(authorization);
    return this.pat.identity(identity.membership, identity.tokenView ?? null);
  }

  @Get("tokens")
  async listTokens(@Headers("authorization") authorization?: string): Promise<ApiTokenList> {
    const identity = await this.identify(authorization);
    return { tokens: await this.pat.listTokens(identity.membership.id) };
  }

  /**
   * 签发新凭据。
   *
   * PAT 调用者必须有 `write`；且不能让低权凭据给自己扩权：
   * 只有 OIDC 人类会话或已经持有 approve 的凭据才能签发 approve。
   */
  @Post("tokens")
  @HttpCode(201)
  async createToken(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const identity = await this.identify(authorization);
    PersonalAccessController.requireScope(identity, "write");
    const input = parseInput(CreateApiTokenInput, body ?? {});
    if (
      input.scopes.includes("approve") &&
      identity.tokenScopes &&
      !identity.tokenScopes.includes("approve")
    ) {
      throw new HttpException(
        {
          error: {
            code: "SCOPE_REQUIRED",
            message: "当前凭据没有 approve 作用域，不能签发带 approve 的新凭据",
          },
        },
        HttpStatus.FORBIDDEN,
      );
    }
    return this.pat.createTokenForMembership({
      membership: identity.membership,
      actorId: identity.tokenScopes
        ? `token:${identity.tokenView?.id}`
        : `oidc:${identity.claims.sub}`,
      body: input,
    });
  }

  @Delete("tokens/:id")
  async revokeToken(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
  ) {
    const identity = await this.identify(authorization);
    return this.pat.revokeToken({
      membership: identity.membership,
      actorId: identity.tokenScopes
        ? `token:${identity.tokenView?.id}`
        : `oidc:${identity.claims.sub}`,
      tokenId: id,
    });
  }

  /** CLI 第一步：申请登录会话（公开）。 */
  @Post("device/start")
  @HttpCode(201)
  async startDevice(@Body() body: unknown) {
    return this.pat.startDevice(parseInput(DeviceAuthorizationStartInput, body ?? {}));
  }

  /** CLI 第二步：轮询；批准后一次性换到明文 token（公开）。 */
  @Post("device/poll")
  @HttpCode(200)
  async pollDevice(@Body() body: unknown) {
    const { deviceCode } = parseInput(DeviceAuthorizationPollInput, body ?? {});
    return this.pat.pollDevice(deviceCode);
  }

  /**
   * 人类在 `/cli-login` 页面确认。必须带登录态（OIDC 或已批准的 PAT）：
   * 身份决定凭据归属，表单不再自报邮箱。
   */
  @Post("device/decide")
  @HttpCode(200)
  async decideDevice(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const identity = await this.identify(authorization);
    PersonalAccessController.requireScope(identity, "approve");
    const decision = parseInput(DeviceAuthorizationDecision, body ?? {});
    return this.pat.decideDevice({ decision, membership: identity.membership });
  }
}
