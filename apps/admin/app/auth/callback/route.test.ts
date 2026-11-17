import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionMaxAge } from "@/src/session-max-age";
import { GET } from "./route";

function jwtWithExp(exp: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode({ exp })}.sig`;
}

/**
 * 域名由环境变量注入（容器内 PLATFORM_PUBLIC_URL），测试不写死任何真实域名：
 * 用 RFC 2606 保留的 example.test 作占位，断言只验证「回跳地址取自注入的变量」。
 */
const PUBLIC_ORIGIN = "https://platform.example.test";
// 容器内收到的请求 origin 是内部地址，回跳地址必须来自注入的环境变量。
const internalCallback = "http://localhost:3003/auth/callback?code=test-code&state=test-state";

function callbackRequest(cookie?: string) {
  return new NextRequest(internalCallback, {
    headers: cookie ? { cookie } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("平台端 OIDC 回调", () => {
  it("state 校验失败时跳回公网登录页", async () => {
    vi.stubEnv("PLATFORM_PUBLIC_URL", PUBLIC_ORIGIN);

    const response = await GET(callbackRequest());
    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(307);
    expect(location.origin).toBe(PUBLIC_ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("state 校验失败，请重新登录");
    expect(response.headers.get("location")).not.toContain("localhost");
  });

  it("登录成功时使用公网回调地址并跳转公网目标页", async () => {
    vi.stubEnv("PLATFORM_PUBLIC_URL", PUBLIC_ORIGIN);
    vi.stubEnv("CASDOOR_ISSUER", "https://sso.wnbgj.com");
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id_token: "test-id-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      callbackRequest(
        "weave_platform_oidc_state=test-state; weave_platform_oidc_verifier=test-verifier; weave_platform_oidc_next=/tenants/acme",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/tenants/acme`);
    expect(response.headers.get("location")).not.toContain("localhost");
    expect(response.cookies.get("weave_platform_token")?.value).toBe("test-id-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [tokenUrl, init] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe("https://sso.wnbgj.com/api/login/oauth/access_token");
    const form = new URLSearchParams(init?.body as string);
    expect(form.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/auth/callback`);
    expect(form.get("redirect_uri")).not.toContain("localhost");
    expect(form.get("code_verifier")).toBe("test-verifier");
  });

  it("换 token 失败时跳回公网登录页", async () => {
    vi.stubEnv("PLATFORM_PUBLIC_URL", PUBLIC_ORIGIN);
    vi.stubEnv("CASDOOR_ISSUER", "https://sso.wnbgj.com");
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error_description: "授权码已失效" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      callbackRequest("weave_platform_oidc_state=test-state; weave_platform_oidc_next=/"),
    );
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe(PUBLIC_ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("授权码已失效");
    expect(response.headers.get("location")).not.toContain("localhost");
  });

  it("开发环境没注入域名时回退到当前请求 origin", async () => {
    vi.stubEnv("PLATFORM_PUBLIC_URL", undefined);
    vi.stubEnv("NODE_ENV", "development");

    const response = await GET(callbackRequest());
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe("http://localhost:3003");
    expect(location.pathname).toBe("/login");
  });

  it("生产环境没注入域名时直接报错，不静默回退到容器地址", async () => {
    vi.stubEnv("PLATFORM_PUBLIC_URL", undefined);
    vi.stubEnv("NODE_ENV", "production");

    await expect(GET(callbackRequest())).rejects.toThrow(/PLATFORM_PUBLIC_URL/);
  });
});

describe("会话 cookie 寿命对齐令牌 exp", () => {
  const now = 1_700_000_000_000;

  it("JWT exp 决定 cookie 寿命（含 30s 时钟偏差）", () => {
    expect(sessionMaxAge(jwtWithExp(now / 1000 + 3600), now)).toBe(3630);
  });

  it("opaque / 非 JWT 令牌退回 8h 默认值", () => {
    expect(sessionMaxAge("test-id-token", now)).toBe(8 * 60 * 60);
  });

  it("已过期令牌给最短寿命，由控制面验签最终判定", () => {
    expect(sessionMaxAge(jwtWithExp(now / 1000 - 100), now)).toBe(60);
  });

  it("超长 exp 被夹到 24h 上限", () => {
    expect(sessionMaxAge(jwtWithExp(now / 1000 + 10 * 24 * 3600), now)).toBe(24 * 60 * 60);
  });
});
