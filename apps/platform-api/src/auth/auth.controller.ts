import { Controller, Get, Headers, Post, Req } from "@nestjs/common";
import type { PlatformRequest } from "./auth.service";
import { Public, RequirePermission } from "./decorators";

@Controller("platform/api/auth")
export class AuthController {
  @Get("me")
  @RequirePermission()
  me(@Req() request: PlatformRequest) {
    const actor = request.platformActor;
    if (!actor) throw new Error("guard 未注入 actor");
    return {
      subject: actor.sub,
      name: actor.name,
      email: actor.email,
      role: actor.role,
      permissions: actor.permissions,
      mfaRequired: true,
    };
  }

  /** 本地开发身份列表：生产直接 404（由控制器内判断环境）。 */
  @Get("dev-identities")
  @Public()
  devIdentities() {
    if (process.env.NODE_ENV === "production") {
      return { identities: [] };
    }
    return {
      identities: [
        { subject: "owner", label: "平台 Owner", role: "platform_owner" },
        { subject: "owner2", label: "平台 Owner（复核）", role: "platform_owner" },
        { subject: "finance", label: "平台财务", role: "platform_finance" },
        { subject: "ops", label: "平台运维", role: "platform_ops" },
        { subject: "support", label: "平台客服", role: "platform_support" },
        { subject: "readonly", label: "只读", role: "platform_readonly" },
      ],
    };
  }

  /** dev 登录校验：确认 subject 在名册内；真实令牌由 admin BFF 写入 Cookie。 */
  @Post("dev-login")
  @Public()
  devLogin(@Headers("x-platform-subject") subject: string | undefined) {
    if (process.env.NODE_ENV === "production") return { ok: false };
    if (!subject) return { ok: false, error: "缺少 x-platform-subject" };
    return { ok: true, token: `dev:${subject.replace(/^dev:/, "")}` };
  }
}
