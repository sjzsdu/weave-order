import { describe, expect, it } from "vitest";
import { ApiError } from "@weave-order/core";
import { linkErrorCopy } from "./link-errors";

const FALLBACK = "这条链接暂时打不开，请稍后重试。";

describe("linkErrorCopy", () => {
  it("401 只给「重新登录」，绝不回显底层技术串", () => {
    const copy = linkErrorCopy(
      new ApiError(401, "UNAUTHENTICATED", "Invalid Compact JWS"),
      FALLBACK,
    );
    expect(copy).toBe("登录已过期，请重新登录后再打开这条链接。");
    expect(copy).not.toContain("JWS");
  });

  it("410/403/409 的业务话术原样展示", () => {
    expect(
      linkErrorCopy(
        new ApiError(410, "INVALID_INPUT", "这条邀请已被接受或已撤销，请让邀请人重新发一条"),
        FALLBACK,
      ),
    ).toContain("已被接受或已撤销");
    expect(
      linkErrorCopy(new ApiError(403, "FORBIDDEN", "请用被邀请的邮箱登录后再接受邀请"), FALLBACK),
    ).toContain("被邀请的邮箱");
  });

  it("4xx 里混进技术串时退回兜底文案", () => {
    expect(linkErrorCopy(new ApiError(400, "INVALID_INPUT", "Invalid Compact JWS"), FALLBACK)).toBe(
      FALLBACK,
    );
    expect(linkErrorCopy(new ApiError(409, "CONFLICT", "session:abc 冲突"), FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("5xx 与网络错误不暴露实现细节", () => {
    expect(linkErrorCopy(new ApiError(500, "INTERNAL", "fetch failed"), FALLBACK)).toBe(
      "服务暂时不可用，请稍后重试。",
    );
    expect(linkErrorCopy(new Error("ECONNREFUSED"), FALLBACK)).toBe(FALLBACK);
    expect(linkErrorCopy(null, FALLBACK)).toBe(FALLBACK);
  });
});
