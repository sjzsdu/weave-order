import { describe, expect, it, vi } from "vitest";
import { HttpImageFetcher, parseAllowedHosts } from "../src/platform/media";

function response(body: Buffer, init: { type?: string; length?: number } = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": init.type ?? "image/jpeg",
      ...(init.length !== undefined ? { "content-length": String(init.length) } : {}),
    },
  });
}

describe("T-001 imageUrl 取图安全边界", () => {
  it("解析逗号分隔的白名单并去空白", () => {
    expect(parseAllowedHosts(" cdn.weaveorder.cn, localhost ,")).toEqual([
      "cdn.weaveorder.cn",
      "localhost",
    ]);
  });

  it("不在白名单的主机直接拒绝，不发起请求", async () => {
    const fetchImpl = vi.fn();
    const fetcher = new HttpImageFetcher({
      allowedHosts: ["cdn.weaveorder.cn"],
      fetchImpl,
    });
    await expect(fetcher.fetchImage("https://evil.example.com/a.jpg")).rejects.toThrow("白名单");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("生产 URL 必须是 https（本地 localhost 例外）", async () => {
    const fetcher = new HttpImageFetcher({
      allowedHosts: ["cdn.weaveorder.cn"],
      fetchImpl: vi.fn(),
    });
    await expect(fetcher.fetchImage("http://cdn.weaveorder.cn/a.jpg")).rejects.toThrow("https");
  });

  it("返回允许的 mimeType 与 base64", async () => {
    const bytes = Buffer.from("fabric");
    const fetcher = new HttpImageFetcher({
      allowedHosts: ["cdn.weaveorder.cn"],
      fetchImpl: () => Promise.resolve(response(bytes, { type: "image/webp; charset=binary" })),
    });
    await expect(fetcher.fetchImage("https://cdn.weaveorder.cn/a.webp")).resolves.toEqual({
      mimeType: "image/webp",
      base64: bytes.toString("base64"),
    });
  });

  it("拒绝非图片 content-type 与超限体积", async () => {
    const html = new HttpImageFetcher({
      allowedHosts: ["cdn.weaveorder.cn"],
      fetchImpl: () => Promise.resolve(response(Buffer.from("<html>"), { type: "text/html" })),
    });
    await expect(html.fetchImage("https://cdn.weaveorder.cn/a.jpg")).rejects.toThrow("不支持");

    const tooBig = new HttpImageFetcher({
      allowedHosts: ["cdn.weaveorder.cn"],
      maxBytes: 4,
      fetchImpl: () => Promise.resolve(response(Buffer.from("12345"), { type: "image/jpeg" })),
    });
    await expect(tooBig.fetchImage("https://cdn.weaveorder.cn/a.jpg")).rejects.toThrow("上限");
  });

  it("不跟随重定向", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response(Buffer.from("x"))));
    const fetcher = new HttpImageFetcher({
      allowedHosts: ["cdn.weaveorder.cn"],
      fetchImpl,
    });
    await fetcher.fetchImage("https://cdn.weaveorder.cn/a.jpg");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cdn.weaveorder.cn/a.jpg",
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
