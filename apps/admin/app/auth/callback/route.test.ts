import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const publicOrigin = "https://weave-admin.wnbgj.com";
const internalCallback =
  "http://localhost:3003/auth/callback?code=test-code&state=test-state";

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
    vi.stubEnv("PLATFORM_PUBLIC_URL", publicOrigin);

    const response = await GET(callbackRequest());
    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(307);
    expect(location.origin).toBe(publicOrigin);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("state 校验失败，请重新登录");
  });

  it("登录成功时使用公网回调地址并跳转公网目标页", async () => {
    vi.stubEnv("PLATFORM_PUBLIC_URL", publicOrigin);
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
    expect(response.headers.get("location")).toBe(`${publicOrigin}/tenants/acme`);
    expect(response.cookies.get("weave_platform_token")?.value).toBe("test-id-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [tokenUrl, init] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe("https://sso.wnbgj.com/api/login/oauth/access_token");
    const form = new URLSearchParams(init?.body as string);
    expect(form.get("redirect_uri")).toBe(`${publicOrigin}/auth/callback`);
    expect(form.get("code_verifier")).toBe("test-verifier");
  });
});
