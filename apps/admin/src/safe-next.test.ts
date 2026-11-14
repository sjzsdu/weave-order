import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("平台端登录回跳地址白名单", () => {
  it.each([undefined, null, "", "   "])("空值 %s 回首页", (value) => {
    expect(safeNext(value)).toBe("/");
  });

  it.each([
    "https://evil.example",
    "http://evil.example/steal",
    "//evil.example",
    "/\\evil.example",
    "\\evil.example",
    "/login",
    "/auth/callback",
    "/api/health",
    "/index.html",
    "/download.html?x=1",
    "/tenants\u0000",
    "/tenants\r\nSet-Cookie: x=1",
  ])("拒绝越界地址 %j", (value) => {
    expect(safeNext(value)).toBe("/");
  });

  it.each(["/", "/today", "/tenants?status=active", "/settings/llm", "/tenants/abc"])(
    "放行站内路径 %s",
    (value) => {
      expect(safeNext(value)).toBe(value);
    },
  );

  it("去掉首尾空白后仍然只认站内路径", () => {
    expect(safeNext("  /tenants  ")).toBe("/tenants");
    expect(safeNext("  https://evil.example ")).toBe("/");
  });
});
