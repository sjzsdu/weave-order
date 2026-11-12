import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
} from "@nestjs/common";
import {
  CreateApiTokenInput,
  DeviceAuthorizationDecision,
  DeviceAuthorizationPollInput,
  DeviceAuthorizationStartInput,
} from "@weave-order/schema";
import { AuthService } from "./auth.service";
import { RequireScope, requireAuth } from "./auth.guard";
import type { AuthRequest } from "./auth.guard";
import { renderCliLoginPage, renderCliLoginResult } from "./cli-login.page";
import { AuthError, AuthErrorFilter } from "./errors";
import { parseInput } from "./input";

const HTML = "text/html; charset=utf-8";

/**
 * 个人凭据管理 + CLI 设备登录。
 *
 * - `/api/auth/me`、`/api/auth/tokens*` 必须带 bearer token（只能操作自己的凭据）；
 * - `/api/auth/device/start|poll` 面向尚未登录的 CLI，无需凭据；
 * - `/api/auth/device/decide` 由浏览器确认页调用，等于「人类本人确认」。
 */
@Controller("api/auth")
@UseFilters(AuthErrorFilter)
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get("me")
  me(@Req() request: AuthRequest) {
    return this.auth.identity(requireAuth(request));
  }

  @Get("tokens")
  async listTokens(@Req() request: AuthRequest) {
    const identity = requireAuth(request);
    return this.auth.listTokens(identity.user.id);
  }

  /** 签发新凭据属于敏感写操作：只读凭据不能给自己扩权。 */
  @Post("tokens")
  @RequireScope("write")
  @HttpCode(201)
  async createToken(@Req() request: AuthRequest, @Body() body: unknown) {
    const identity = requireAuth(request);
    return this.auth.createTokenForUser({
      userId: identity.user.id,
      actorId: `user:${identity.user.id}`,
      body: parseInput(CreateApiTokenInput, body ?? {}),
    });
  }

  @Delete("tokens/:id")
  async revokeToken(@Req() request: AuthRequest, @Param("id") id: string) {
    const identity = requireAuth(request);
    return this.auth.revokeToken({
      userId: identity.user.id,
      actorId: `user:${identity.user.id}`,
      tokenId: id,
    });
  }

  /** CLI 第一步：申请登录会话。 */
  @Post("device/start")
  @HttpCode(201)
  async startDevice(@Body() body: unknown) {
    const input = parseInput(DeviceAuthorizationStartInput, body ?? {});
    return this.auth.startDevice(input);
  }

  /** CLI 第二步：轮询结果；批准后一次性换到明文 token。 */
  @Post("device/poll")
  @HttpCode(200)
  async pollDevice(@Body() body: unknown) {
    const { deviceCode } = parseInput(DeviceAuthorizationPollInput, body ?? {});
    return this.auth.pollDevice(deviceCode);
  }

  /** 确认页用的 JSON 入口（表单提交走下面的 /cli-login）。 */
  @Post("device/decide")
  @HttpCode(200)
  async decideDevice(@Body() body: unknown) {
    return this.auth.decideDevice(parseInput(DeviceAuthorizationDecision, body ?? {}));
  }
}

/**
 * 浏览器确认页。与 API 同一进程，便于本地 CLI 登录开箱即用；
 * 生产环境会把 verificationUri 指向租户端页面（PUBLIC_API_URL 控制）。
 */
@Controller()
export class CliLoginPageController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get("cli-login")
  @Header("Content-Type", HTML)
  page(@Query("user_code") userCode?: string): string {
    return renderCliLoginPage({ userCode: userCode ?? "" });
  }

  @Post("cli-login")
  @HttpCode(200)
  @Header("Content-Type", HTML)
  async submit(@Body() body: Record<string, unknown>): Promise<string> {
    const form = body ?? {};
    const userCode = typeof form.userCode === "string" ? form.userCode : "";
    const email = typeof form.email === "string" ? form.email : "";
    const name = typeof form.name === "string" && form.name.trim() ? form.name : undefined;
    // 只有显式点「批准登录」才算批准；回车 / 缺字段一律按拒绝处理。
    const approve = form.decision === "approve";
    const allowApprove = form.allowApprove === "1" || form.allowApprove === "true";

    try {
      const result = await this.auth.decideDevice({
        userCode,
        email,
        name,
        approve,
        scopes: allowApprove ? ["read", "write", "approve"] : ["read", "write"],
      });
      return renderCliLoginResult({
        approved: result.approved,
        email: result.email,
        userCode: result.userCode,
      });
    } catch (error) {
      const message =
        error instanceof AuthError
          ? error.message
          : error instanceof Error
            ? error.message
            : "确认失败，请稍后重试";
      return renderCliLoginPage({ userCode, error: message });
    }
  }
}
