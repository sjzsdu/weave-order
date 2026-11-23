import { describe, expect, it } from "vitest";
import {
  QuoteApiBaseMissingError,
  resolveQuoteApiBase,
  tryResolveQuoteApiBase,
} from "../src/api-base";

describe("客户报价页 API 根地址解析", () => {
  it("显式配置原样返回，并去掉尾部斜杠", () => {
    expect(resolveQuoteApiBase({ QUOTE_API_BASE_URL: "https://weave-api.wnbgj.com/" })).toBe(
      "https://weave-api.wnbgj.com",
    );
    expect(resolveQuoteApiBase({ QUOTE_API_BASE_URL: "  https://a/b  " })).toBe("https://a/b");
  });

  it("dev 未配置时回落本地 3000", () => {
    expect(resolveQuoteApiBase({ NODE_ENV: "development" })).toBe("http://localhost:3000");
  });

  it("生产未配置时抛错而不是回落", () => {
    expect(() => resolveQuoteApiBase({ NODE_ENV: "production" })).toThrow(
      QuoteApiBaseMissingError,
    );
  });

  it("渲染侧把配置缺失降级成可读状态，而不是让整页 500", () => {
    const missing = tryResolveQuoteApiBase({ NODE_ENV: "production" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("QUOTE_API_BASE_URL");

    const ready = tryResolveQuoteApiBase({
      NODE_ENV: "production",
      QUOTE_API_BASE_URL: "https://weave-api.wnbgj.com",
    });
    expect(ready).toEqual({ ok: true, base: "https://weave-api.wnbgj.com" });
  });
});
