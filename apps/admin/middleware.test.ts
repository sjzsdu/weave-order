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

  it("带任意 cookie（含过期 JWT）一律放行，middleware 不本地判过期、不删 cookie", () => {
    // 会话有效性由控制面验签判定；middleware 本地解 exp 会因时钟偏差/opaque 令牌/JWKS
    // 轮转误杀正常会话，且删 cookie 会把可恢复的验签失败升级成不可逆登出。
    const expired = middleware(request("/", `weave_platform_token=${expiredToken}`));
    expect(expired.status).toBe(200);
    expect(expired.headers.get("set-cookie") ?? "").not.toContain("weave_platform_token");
  });

  it("未过期 JWT 放行", () => {
    expect(middleware(request("/", `weave_platform_token=${validToken}`)).status).toBe(200);
  });

  it("生产环境带 dev 令牌 cookie 也不在 middleware 拦截（交控制面拒绝）", () => {
    // dev 令牌在生产应由 platform-api 验签返回 403 → layout 分流到 no-access。
    // middleware 不再主动清 cookie 或跳登录，避免「点菜单被登出」。
    expect(middleware(request("/", "weave_platform_token=dev:owner")).status).toBe(200);
  });

  it("登录、认证、BFF 与静态资源前缀不拦截", () => {
    for (const path of [
      "/login",
      "/auth/login",
      "/api/health",
      "/_next/static/a.js",
      "/favicon.ico",
      "/brand/logo-mark.svg",
      "/icon.svg",
      "/apple-icon.png",
    ]) {
      expect(middleware(request(path)).status).toBe(200);
    }
  });

  it("未登录时品牌图标直接返回，不重定向到登录页", () => {
    const response = middleware(request("/brand/logo-mark.svg"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("本地 dev 直接放行，无 Casdoor 也能联调", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(middleware(request("/")).status).toBe(200);
  });
});
