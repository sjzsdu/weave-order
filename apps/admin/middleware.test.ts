import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { middleware } from "./middleware";

const ORIGIN = "https://platform.example.test";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : undefined);
}

const validToken = jwt({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 3600 });
const expiredToken = jwt({ sub: "admin", exp: Math.floor(Date.now() / 1000) - 3600 });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("平台端 middleware 会话守卫", () => {
  it("无 cookie 时回登录页并保留 next", () => {
    const response = middleware(request("/tenants"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/tenants");
    expect(location.searchParams.get("error")).toBeNull();
  });

  it("过期 JWT 不进控制台 SSR，并就地清除 cookie", () => {
    const response = middleware(request("/", `weave_platform_token=${expiredToken}`));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toContain("会话已失效");
    expect(response.headers.get("set-cookie") ?? "").toContain("weave_platform_token");
  });

  it("未过期 JWT 放行", () => {
    expect(middleware(request("/", `weave_platform_token=${validToken}`)).status).toBe(200);
  });

  it("生产环境拒收 dev 令牌", () => {
    const response = middleware(request("/", "weave_platform_token=dev:owner"));
    expect(response.status).toBe(307);
  });

  it("登录、认证、BFF 与静态资源前缀不拦截", () => {
    for (const path of [
      "/login",
      "/auth/login",
      "/api/health",
      "/_next/static/a.js",
      "/favicon.ico",
    ]) {
      expect(middleware(request(path)).status).toBe(200);
    }
  });

  it("本地 dev 直接放行，无 Casdoor 也能联调", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(middleware(request("/")).status).toBe(200);
  });
});
