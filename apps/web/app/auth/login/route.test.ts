import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 域名由环境变量注入（容器内 WEB_APP_URL），测试不写死任何真实域名。
 */
const PUBLIC_ORIGIN = "https://tenant.example.test";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("租户端登录跳转", () => {
  it("redirect_uri 用注入的公网地址，不带容器内部地址", () => {
    vi.stubEnv("WEB_APP_URL", PUBLIC_ORIGIN);
    vi.stubEnv("CASDOOR_ISSUER", "https://sso.wnbgj.com");

    const response = GET(new NextRequest("http://localhost:3001/auth/login?next=/today"));
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe("https://sso.wnbgj.com");
    expect(location.searchParams.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/auth/callback`);
    expect(location.searchParams.get("redirect_uri")).not.toContain("localhost");
  });

  it("注入值带结尾斜杠时 redirect_uri 也不会出现双斜杠", () => {
    vi.stubEnv("WEB_APP_URL", `${PUBLIC_ORIGIN}/`);
    vi.stubEnv("CASDOOR_ISSUER", "https://sso.wnbgj.com");

    const response = GET(new NextRequest("http://localhost:3001/auth/login"));
    const location = new URL(response.headers.get("location")!);

    expect(location.searchParams.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/auth/callback`);
  });

  it("生产环境没注入域名时直接报错，不静默回退到容器地址", () => {
    vi.stubEnv("WEB_APP_URL", undefined);
    vi.stubEnv("NODE_ENV", "production");

    expect(() => GET(new NextRequest("http://localhost:3001/auth/login"))).toThrow(/WEB_APP_URL/);
  });
});
