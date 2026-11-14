import { Injectable } from "@nestjs/common";
import type { NestMiddleware } from "@nestjs/common";
import { SESSION_COOKIE } from "./session.service";

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
  use(request: RequestWithHeaders, _response: unknown, next: () => void): void {
    const sid = readSessionCookie(request.headers.cookie);
    // PAT（`wo_...`）是 agent/CLI 的显式凭据，作用域比人类会话窄：
    // 两者同时出现时保留 PAT，避免「低权凭据借浏览器 Cookie 提权」。
    const isPersonalToken = /^Bearer\s+wo_/i.test(request.headers.authorization ?? "");
    if (sid && !isPersonalToken) {
      request.headers.authorization = `Bearer session:${sid}`;
    }
    next();
  }
}
