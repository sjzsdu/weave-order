import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 域名由环境变量注入（容器内 WEB_APP_URL），测试不写死任何真实域名：
 * 用 RFC 2606 保留的 example.test 作占位，断言只验证「回跳地址取自注入的变量」。
 */
const PUBLIC_ORIGIN = "https://tenant.example.test";
// 容器内收到的请求 origin 是内部地址，回跳地址必须来自注入的环境变量。
const internalCallback = "http://localhost:3001/auth/callback?code=test-code&state=test-state";

function callbackRequest(cookie?: string) {
  return new NextRequest(internalCallback, {
    headers: cookie ? { cookie } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("租户端 OIDC 回调", () => {
  it("state 校验失败时跳回公网登录页", async () => {
    vi.stubEnv("WEB_APP_URL", PUBLIC_ORIGIN);

    const response = await GET(callbackRequest());
    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(307);
    expect(location.origin).toBe(PUBLIC_ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("state 校验失败");
    expect(response.headers.get("location")).not.toContain("localhost");
  });

  it("缺少授权码时跳回公网登录页", async () => {
    vi.stubEnv("WEB_APP_URL", PUBLIC_ORIGIN);

    const response = await GET(
      new NextRequest("http://localhost:3001/auth/callback?state=test-state"),
    );
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe(PUBLIC_ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("缺少授权码");
    expect(response.headers.get("location")).not.toContain("localhost");
  });

  it("登录成功时用公网地址回跳，token 交换也用公网 redirect_uri", async () => {
    vi.stubEnv("WEB_APP_URL", PUBLIC_ORIGIN);
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
        "weave_oidc_state=test-state; weave_oidc_verifier=test-verifier; weave_oidc_next=/today",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/today`);
    expect(response.headers.get("location")).not.toContain("localhost");
    expect(response.cookies.get("weave_token")?.value).toBe("test-id-token");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [tokenUrl, init] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe("https://sso.wnbgj.com/api/login/oauth/access_token");
    const form = new URLSearchParams(init?.body as string);
    expect(form.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/auth/callback`);
    expect(form.get("redirect_uri")).not.toContain("localhost");
    expect(form.get("code_verifier")).toBe("test-verifier");
  });

  it("换 token 失败时跳回公网登录页", async () => {
    vi.stubEnv("WEB_APP_URL", PUBLIC_ORIGIN);
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
      callbackRequest("weave_oidc_state=test-state; weave_oidc_next=/today"),
    );
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe(PUBLIC_ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("授权码已失效");
    expect(response.headers.get("location")).not.toContain("localhost");
  });

  it("开发环境没注入域名时回退到当前请求 origin", async () => {
    vi.stubEnv("WEB_APP_URL", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "dev");

    const response = await GET(callbackRequest());
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe("http://localhost:3001");
    expect(location.pathname).toBe("/login");
  });

  it("staging（NODE_ENV=development + AUTH_MODE=oidc）会话 cookie 仍是 Secure，与生产一致", async () => {
    vi.stubEnv("WEB_APP_URL", PUBLIC_ORIGIN);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "oidc");
    vi.stubEnv("CASDOOR_ISSUER", "https://sso.wnbgj.com");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id_token: "test-id-token" }), { status: 200 }),
        ),
      ),
    );

    const response = await GET(
      callbackRequest("weave_oidc_state=test-state; weave_oidc_verifier=test-verifier"),
    );

    expect(response.cookies.get("weave_token")?.secure).toBe(true);
  });

  it("本地 dev 会话 cookie 不带 Secure，http://localhost 可写", async () => {
    vi.stubEnv("WEB_APP_URL", PUBLIC_ORIGIN);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "dev");
    vi.stubEnv("CASDOOR_ISSUER", "https://sso.wnbgj.com");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id_token: "test-id-token" }), { status: 200 }),
        ),
      ),
    );

    const response = await GET(
      callbackRequest("weave_oidc_state=test-state; weave_oidc_verifier=test-verifier"),
    );

    expect(response.cookies.get("weave_token")?.secure).toBe(false);
  });

  it("生产环境没注入域名时直接报错，不静默回退到容器地址", async () => {
    vi.stubEnv("WEB_APP_URL", undefined);
    vi.stubEnv("NODE_ENV", "production");

    await expect(GET(callbackRequest())).rejects.toThrow(/WEB_APP_URL/);
  });

  it("回跳 cookie 被规整：外站地址不跳转、官网静态页不产生 404", async () => {
    vi.stubEnv("WEB_APP_URL", PUBLIC_ORIGIN);
    vi.stubEnv("CASDOOR_ISSUER", "https://sso.wnbgj.com");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id_token: "test-id-token" }), { status: 200 }),
        ),
      ),
    );

    for (const raw of ["https://evil.example/steal", "/download.html"]) {
      const response = await GET(
        callbackRequest(`weave_oidc_state=test-state; weave_oidc_next=${raw}`),
      );
      expect(response.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/today`);
    }
  });
});
