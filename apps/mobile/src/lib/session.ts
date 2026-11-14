/**
 * 会话令牌：只驻留内存，不落本地明文。
 *
 * 单独成模块是为了让 OIDC 流程与运行时装配层互不循环依赖：
 * oidc.ts 只依赖这里，runtime.ts 从这里 re-export 并依赖 oidc.ts。
 * 冷启动 / 刷新后令牌必然丢失，按设计重新走 OIDC 登录。
 */

export const TOKEN_KEY = "weave.session.token";

let memoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}
