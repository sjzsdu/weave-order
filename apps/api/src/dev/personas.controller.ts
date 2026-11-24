import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Res } from "@nestjs/common";
import {
  DevPersonaListResponse,
  DevSessionInput,
  PERSONAS,
  personaByKey,
} from "@weave-order/schema";
import { DEFAULT_TENANT_ID } from "../kernel";
import { toHttpError } from "../gateway/auth.controller";
import { AuthService } from "../gateway/auth.service";
import { SESSION_COOKIE } from "../gateway/session.service";
import { readSessionCookie } from "../gateway/session-credential.middleware";
import { isProductionLike } from "../platform/runtime-mode";

interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
}

/** seed 与 dev 端点必须指向同一个租户，否则切过去查不到 persona 的 membership。 */
function demoTenantId(): string {
  const raw = process.env.SEED_TENANT_ID;
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_TENANT_ID;
}

/**
 * 本地 dev 的 persona 切换面（WAN-136）。
 *
 * 只在 `AUTH_MODE=dev` 且非生产态时注册（见 `devPersonasEnabled`）；生产/OIDC
 * 镜像里这两个路由不存在，请求得到 404 而不是 403。客户端只传 `personaKey`，
 * 服务端按目录找到 subject，再走与真实登录同一条
 * `resolveOrThrow(sub, tenantId)` + `sessions.create` 路径。
 */
@Controller("api/dev")
export class DevPersonasController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** 身份条与 e2e 都读这一份目录，避免前端另抄一遍角色清单。 */
  @Get("personas")
  personas() {
    return DevPersonaListResponse.parse({ personas: PERSONAS });
  }

  /**
   * 换会话即换身份。`tenantId` 永远由服务端决定；
   * 请求体带 role/dataScope/tenantId 会被 `.strict()` 拒绝（400），
   * 而不是「忽略后照常切换」。
   */
  @Post("session")
  @HttpCode(200)
  async createSession(
    @Headers("cookie") cookie: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    // 契约校验放在 try 外：ZodError 交给全局 ZodExceptionFilter → 400 INVALID_INPUT。
    const input = DevSessionInput.parse(body ?? {});
    try {
      const persona = personaByKey(input.personaKey);
      if (!persona) {
        // 理论上 PersonaKey 枚举已挡住；保留兜底，避免目录与枚举漂移时静默用错人。
        throw new Error(`未知 persona：${input.personaKey}`);
      }
      const result = await this.auth.openPersonaSession(readSessionCookie(cookie), {
        subject: persona.subject,
        tenantId: demoTenantId(),
      });
      if (!result.sid) throw new Error("persona 会话没有返回 sid");
      response.cookie(SESSION_COOKIE, result.sid, {
        httpOnly: true,
        sameSite: "lax",
        secure: isProductionLike(),
        path: "/",
        maxAge: this.auth.ttl() * 1000,
      });
      return result.body;
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
