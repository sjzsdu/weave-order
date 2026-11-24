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
  it("staging（NODE_ENV=development + AUTH_MODE=oidc）未登录 → 直接发起 OIDC 登录", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "oidc");

    const response = middleware(request("/today?tab=mine"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("next")).toBe("/today?tab=mine");
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

  it("生产未登录 → 直接发起 OIDC 登录", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "oidc");

    const response = middleware(request("/panorama"));
    const location = new URL(response.headers.get("location")!);
    expect(response.status).toBe(307);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("next")).toBe("/panorama");
  });

  it("旧 /login 地址不再展示登录页，而是按会话直达工作台或 OIDC", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "oidc");

    const anonymous = middleware(request("/login?next=%2Fpanorama"));
    const anonymousLocation = new URL(anonymous.headers.get("location")!);
    expect(anonymousLocation.pathname).toBe("/auth/login");
    expect(anonymousLocation.searchParams.get("next")).toBe("/panorama");

    const signedIn = middleware(request("/login?next=%2Fpanorama", "weave_token=oidc-token"));
    expect(new URL(signedIn.headers.get("location")!).pathname).toBe("/panorama");
  });

  it("登录失败与主动退出时保留提示页，认证路由、BFF、/config.js 永不拦截", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "oidc");

    for (const path of [
      "/login?error=state",
      "/login?loggedOut=1",
      "/auth/login",
      "/api/health",
      "/config.js",
      "/_next/static/a.js",
    ]) {
      expect(middleware(request(path)).status).toBe(200);
    }
  });
});

/**
 * 发布验收靠这个响应头核对版本（页脚只有登录后才看得到，`/today` 未登录是 307）。
 * 两条底线：注入了就如实带上；没注入就一个版本都不带，不编。
 */
describe("发布版本响应头", () => {
  it("构建期注入了版本时，放行与跳转的响应都带 x-weave-version", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "oidc");
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "0.1.9");

    expect(middleware(request("/login")).headers.get("x-weave-version")).toBe("v0.1.9");
    expect(middleware(request("/today")).headers.get("x-weave-version")).toBe("v0.1.9");
  });

  it("没注入或值不可信时不带版本头", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "oidc");

    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "");
    expect(middleware(request("/login")).headers.get("x-weave-version")).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "77b6ef4abcde");
    expect(middleware(request("/login")).headers.get("x-weave-version")).toBeNull();
  });
});
