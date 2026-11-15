import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { middleware } from "./middleware";

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(
    `http://localhost:3001${path}`,
    cookie ? { headers: { cookie } } : undefined,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * 守卫必须和 api 用同一份生产态判定：
 * `NODE_ENV=development + AUTH_MODE=oidc`（staging）下未登录不能放行，
 * 否则 staging 能在没有会话的情况下直接进工作台。
 */
describe("租户端 middleware 会话守卫", () => {
  it("staging（NODE_ENV=development + AUTH_MODE=oidc）未登录 → 回登录页", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "oidc");

    const response = middleware(request("/today"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/today");
  });

  it("staging 带 token cookie 时放行", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "oidc");

    expect(middleware(request("/today", "weave_token=oidc-token")).status).toBe(200);
  });

  it("本地 dev（NODE_ENV=development + AUTH_MODE=dev）放行，便于无 Casdoor 联调", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "dev");

    expect(middleware(request("/today")).status).toBe(200);
  });

  it("生产未登录 → 回登录页", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "oidc");

    expect(middleware(request("/panorama")).status).toBe(307);
  });

  it("登录页、认证路由、BFF、/config.js 永不拦截", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "oidc");

    for (const path of [
      "/login",
      "/auth/login",
      "/api/health",
      "/config.js",
      "/_next/static/a.js",
    ]) {
      expect(middleware(request(path)).status).toBe(200);
    }
  });
});
