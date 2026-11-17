import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

/**
 * 回归：侧栏「退出」曾是 <Link href="/auth/logout">，Next 预取视口内链接时
 * 就执行了 GET 登出，用户点任意菜单都会被静默踢下线。
 */
const PUBLIC_ORIGIN = "https://platform.example.test";

function post(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${PUBLIC_ORIGIN}/auth/logout`, { method: "POST", headers });
}

function deletedSessionCookie(response: Response): boolean {
  const cookie = response.headers.get("set-cookie") ?? "";
  return (
    cookie.includes("weave_platform_token=") &&
    cookie.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
  );
}

beforeEach(() => {
  vi.stubEnv("PLATFORM_PUBLIC_URL", PUBLIC_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /auth/logout（预取/旧链接）", () => {
  it("不再清除会话，只返回确认页", () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("确认页里是 POST 表单，需要用户再点一次才登出", async () => {
    const html = await GET().text();

    expect(html).toContain('method="post"');
    expect(html).toContain('action="/auth/logout"');
  });
});

describe("POST /auth/logout", () => {
  it("同源请求清 cookie 并 303 回登录页", () => {
    const response = POST(post({ origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" }));

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(deletedSessionCookie(response)).toBe(true);
  });

  it("缺少 Origin 时用 Sec-Fetch-Site 判定同源", () => {
    const response = POST(post({ "sec-fetch-site": "same-origin" }));

    expect(response.status).toBe(303);
    expect(deletedSessionCookie(response)).toBe(true);
  });

  it("只带同源 Referer 也能通过", () => {
    const response = POST(post({ referer: `${PUBLIC_ORIGIN}/tenants` }));

    expect(response.status).toBe(303);
    expect(deletedSessionCookie(response)).toBe(true);
  });

  it("跨站 Origin 拒绝，不删 cookie", () => {
    const response = POST(post({ origin: "https://evil.example" }));

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("跨站表单（Sec-Fetch-Site: cross-site）拒绝", () => {
    const response = POST(post({ "sec-fetch-site": "cross-site" }));

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("完全没有来源信息时按跨站处理", () => {
    const response = POST(post());

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("公网域名与容器内部地址不同时，以 PLATFORM_PUBLIC_URL 为准", () => {
    const response = POST(
      new NextRequest("http://localhost:3003/auth/logout", {
        method: "POST",
        headers: { origin: PUBLIC_ORIGIN },
      }),
    );

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).origin).toBe(PUBLIC_ORIGIN);
  });
});
