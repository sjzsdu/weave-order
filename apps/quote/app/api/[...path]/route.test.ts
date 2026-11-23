import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

/** 把上游响应替换成测试桩，不真的发网络请求。 */
function stubUpstream(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return await impl(url, init);
  });
  return calls;
}

beforeEach(() => {
  process.env.QUOTE_API_BASE_URL = "http://upstream.test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.QUOTE_API_BASE_URL;
});

describe("客户报价页同源反代", () => {
  it("白名单路径转发到上游，并透传访客 IP 与 UA", async () => {
    const calls = stubUpstream(() => Response.json({ ok: true }));
    const request = new Request("http://quote.test/s/api/public/quotes/abc", {
      headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "ua/1" },
    });

    const response = await GET(request, ctx(["public", "quotes", "abc"]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("http://upstream.test/api/public/quotes/abc");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-forwarded-for"]).toBe("1.2.3.4");
    expect(headers["user-agent"]).toBe("ua/1");
  });

  it("上游 204 原样返回空响应体，不会退化成 503", async () => {
    // 后端「记录 PDF 下载」（POST :token/pdf）是 HttpCode 204。
    // Response 构造函数禁止 204 携带 body，早期实现直接抛 TypeError 变成 503。
    stubUpstream(() => new Response(null, { status: 204 }));

    const response = await POST(
      new Request("http://quote.test/s/api/public/quotes/abc/pdf", { method: "POST" }),
      ctx(["public", "quotes", "abc", "pdf"]),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("上游 304 同样不带响应体", async () => {
    stubUpstream(() => new Response(null, { status: 304 }));

    const response = await GET(
      new Request("http://quote.test/s/api/public/sample-cards/x"),
      ctx(["public", "sample-cards", "x"]),
    );

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("非白名单路径 404，不触碰上游", async () => {
    const calls = stubUpstream(() => Response.json({ ok: true }));

    const response = await GET(
      new Request("http://quote.test/s/api/admin/users"),
      ctx(["admin", "users"]),
    );

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("只允许 GET / POST", async () => {
    const calls = stubUpstream(() => Response.json({ ok: true }));

    const request = new Request("http://quote.test/s/api/public/quotes/abc", { method: "DELETE" });
    const response = await (await import("./route")).GET(request, ctx(["public", "quotes", "abc"]));

    // GET 导出函数只接受 GET；跨方法在这里靠 request.method 判定。
    expect(response.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("上游不可用时返回 503 而不是抛出", async () => {
    stubUpstream(() => {
      throw new Error("ECONNREFUSED");
    });

    const response = await GET(
      new Request("http://quote.test/s/api/public/quotes/abc"),
      ctx(["public", "quotes", "abc"]),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UPSTREAM");
  });
});
