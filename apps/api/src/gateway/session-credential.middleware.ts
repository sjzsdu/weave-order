import { Inject, Injectable, Optional } from "@nestjs/common";
import type { NestMiddleware } from "@nestjs/common";
import { isProductionLike } from "../platform/runtime-mode";
import { SESSION_COOKIE, TENANT_SESSIONS } from "./session.service";
import type { SessionService } from "./session.service";

/** 只解析我们自己的那一个 Cookie，不引入 cookie-parser 依赖。 */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * 会话 Cookie → 统一凭据头。
 *
 * 下游（HumanActorService / 各业务控制器）只认识 `authorization`，所以网关在入口
 * 把 `weave_sid` Cookie 归一成 `Bearer session:<sid>`，避免把「凭据可能有三种形态」
 * 这件事扩散到每一个控制器。
 *
 * 会话优先于 Casdoor 令牌：登录后租户就已经定在会话里，如果继续用 OIDC 的
 * `(sub, org)` 解析，多租户账号会被反复判成「还没选租户」。
 */
interface RequestWithHeaders {
  headers: { cookie?: string; authorization?: string };
}

@Injectable()
export class SessionCredentialMiddleware implements NestMiddleware {
  constructor(
    @Optional()
    @Inject(TENANT_SESSIONS)
    private readonly sessions?: SessionService,
  ) {}

  async use(request: RequestWithHeaders, _response: unknown, next: () => void): Promise<void> {
    const sid = readSessionCookie(request.headers.cookie);
    // PAT（`wo_...`）是 agent/CLI 的显式凭据，作用域比人类会话窄：
    // 两者同时出现时保留 PAT，避免「低权凭据借浏览器 Cookie 提权」。
    const isPersonalToken = /^Bearer\s+wo_/i.test(request.headers.authorization ?? "");
    if (sid && !isPersonalToken) {
      /*
       * 本地 dev 用进程内会话，API 重启后浏览器里的旧 `weave_sid` 已经不存在。
       * 如果继续无条件让会话优先，就会把 BFF 注入的 dev 兜底令牌盖掉，
       * 「AUTH_MODE=dev 免登录」退化成「会话已过期」。所以只在非生产态、
       * 且确实读不到该会话、同时调用方还带了别的凭据时，保留原凭据让下游
       * 走 OIDC/dev 分支重新建会话；有效会话仍然优先（persona 切换依赖它）。
       */
      const staleDevSession =
        Boolean(request.headers.authorization) && (await this.isStaleDevSession(sid));
      if (!staleDevSession) {
        request.headers.authorization = `Bearer session:${sid}`;
      }
    }
    next();
  }

  /** 生产态不做额外读取：旧会话就是未认证，保持既有 401 语义。 */
  private async isStaleDevSession(sid: string): Promise<boolean> {
    if (!this.sessions || isProductionLike()) return false;
    return (await this.sessions.read(sid)) === null;
  }
}
