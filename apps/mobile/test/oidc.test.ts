import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 移动端 H5 的 OIDC PKCE 门禁。
 *
 * 浏览器 API 用最小 stub（不引 jsdom）：Node 22 自带 crypto.subtle / btoa / Response，
 * 只需要模拟 window.location、sessionStorage 与 history.replaceState。
 * 每个用例重新 import，避免模块级 redirecting / 内存令牌在用例间串味。
 */

const ISSUER = "https://sso.example.test";
const REDIRECT_URI = "https://weave-m.example.test/auth/callback";

interface Harness {
  location: { href: string; replace: ReturnType<typeof vi.fn> };
  history: { replaceState: ReturnType<typeof vi.fn> };
  storage: Map<string, string>;
}

function makeWindow(): Harness {
  const location = {
    href: "https://weave-m.example.test/",
    replace: vi.fn((url: string) => {
      location.href = url;
    }),
  };
  const history = {
    replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
      location.href = new URL(url, location.href).toString();
    }),
  };
  const storage = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  };
  vi.stubGlobal("window", {
    __WEAVE_CONFIG__: {
      apiBase: "https://weave-api.example.test",
      issuer: `${ISSUER}/`,
      clientId: "weave-order",
      redirectUri: REDIRECT_URI,
    },
    location,
    history,
    sessionStorage,
  });
  return { location, history, storage };
}

async function loadOidc() {
  vi.resetModules();
  return import("../src/lib/oidc");
}

beforeEach(() => {
  vi.stubEnv("TARO_ENV", "h5");
  vi.stubEnv("NODE_ENV", "production");
  makeWindow();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("移动端 OIDC 配置", () => {
  it("生产 H5 且配置齐全才强制登录；缺配置 / 非生产 / 非 H5 都不拦", async () => {
    const oidc = await loadOidc();
    expect(oidc.isAuthRequired()).toBe(true);
    expect(oidc.authConfig()?.issuer).toBe(ISSUER); // 去掉结尾斜杠

    vi.stubEnv("NODE_ENV", "development");
    expect(oidc.isAuthRequired()).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TARO_ENV", "weapp");
    const weapp = await loadOidc();
    expect(weapp.isAuthRequired()).toBe(false);

    vi.stubEnv("TARO_ENV", "h5");
    vi.stubGlobal("window", { __WEAVE_CONFIG__: { issuer: ISSUER } });
    const partial = await loadOidc();
    expect(partial.authConfig()).toBeNull();
    expect(partial.isAuthRequired()).toBe(false);
  });
});

describe("移动端 OIDC 登录跳转", () => {
  it("未登录时跳 Casdoor，带 PKCE challenge 与 state，且不落 client_secret", async () => {
    const { location, storage } = makeWindow();
    const oidc = await loadOidc();

    const ready = await oidc.ensureAuthenticated();
    expect(ready).toBe(false);
    await vi.waitFor(() => expect(location.replace).toHaveBeenCalledOnce());

    const authorize = new URL(location.replace.mock.calls[0]![0] as string);
    expect(authorize.origin).toBe(ISSUER);
    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("weave-order");
    expect(authorize.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("state")).toBe(storage.get("weave.oidc.state"));
    expect(storage.get("weave.oidc.verifier")).toBeTruthy();
    expect(oidc.getAuthError()).toBeNull();
  });

  it("回调 state 不匹配时不换 token，清掉地址栏与标记里的授权码", async () => {
    const { location, history, storage } = makeWindow();
    // 模拟 head 同步脚本已固化回调 query，且 Taro 已把 pathname 改写成 '/'
    location.href = "https://weave-m.example.test/";
    storage.set("weave.oidc.callback", "code=fake&state=wrong");
    storage.set("weave.oidc.state", "expected");
    storage.set("weave.oidc.verifier", "verifier");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const oidc = await loadOidc();

    const ready = await oidc.ensureAuthenticated();

    expect(ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(location.href).toBe("https://weave-m.example.test/");
    expect(storage.size).toBe(0);
    expect(oidc.getAuthError()).toMatch(/state/);
  });

  it("location 被路由改写后仍凭固化标记识别回调、换 token（线上死循环回归）", async () => {
    const { location, storage } = makeWindow();
    const oidc = await loadOidc();
    const state = "test-state";
    // location 已是根路径（Taro hash 路由改写结果），绝不是 /auth/callback
    location.href = "https://weave-m.example.test/";
    storage.set("weave.oidc.callback", `code=test-code&state=${state}`);
    storage.set("weave.oidc.state", state);
    storage.set("weave.oidc.verifier", "test-verifier");

    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id_token: "test-id-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ready = await oidc.ensureAuthenticated();

    expect(ready).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ISSUER}/api/login/oauth/access_token`);
    const form = new URLSearchParams(init?.body as string);
    expect(form.get("code")).toBe("test-code");
    expect(form.get("code_verifier")).toBe("test-verifier");
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(form.get("client_secret")).toBeNull();
    expect(storage.has("weave.oidc.callback")).toBe(false);
    expect(storage.size).toBe(0);

    const session = await import("../src/lib/session");
    expect(session.getAuthToken()).toBe("test-id-token");
  });

  it("业务请求 401 时清令牌并重新登录，非生产环境不跳", async () => {
    const { location } = makeWindow();
    const oidc = await loadOidc();
    const session = await import("../src/lib/session");
    session.setAuthToken("expired");

    oidc.onUnauthorized();
    expect(session.getAuthToken()).toBeNull();
    await vi.waitFor(() => expect(location.replace).toHaveBeenCalledOnce());
  });
});
