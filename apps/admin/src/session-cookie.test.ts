import { describe, expect, it } from "vitest";
import { platformSessionState } from "./session-cookie";

/** 构造一个带 UTF-8 payload 的 JWT（只用于读取 exp，签名段是假的）。 */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

const NOW = 1_800_000_000_000;
const nowSeconds = NOW / 1000;

describe("平台会话 cookie 轻量判定", () => {
  it("没有 cookie 时报 missing", () => {
    expect(platformSessionState(undefined)).toBe("missing");
    expect(platformSessionState("")).toBe("missing");
  });

  it("未过期 JWT 放行", () => {
    expect(platformSessionState(jwt({ sub: "管理员", exp: nowSeconds + 3600 }), { now: NOW })).toBe(
      "usable",
    );
  });

  it("过期 JWT 报 expired", () => {
    expect(platformSessionState(jwt({ sub: "admin", exp: nowSeconds - 3600 }), { now: NOW })).toBe(
      "expired",
    );
  });

  it("30 秒时钟偏差内不误踢", () => {
    expect(platformSessionState(jwt({ exp: nowSeconds - 10 }), { now: NOW })).toBe("usable");
    expect(platformSessionState(jwt({ exp: nowSeconds - 31 }), { now: NOW })).toBe("expired");
  });

  it("生产环境拒收 dev 令牌，开发环境放行", () => {
    expect(platformSessionState("dev:owner", { production: true })).toBe("dev");
    expect(platformSessionState("dev:owner", { production: false })).toBe("usable");
  });

  it("没有 exp 或读不懂的令牌一律放行，交给控制面验签", () => {
    expect(platformSessionState(jwt({ sub: "admin" }))).toBe("usable");
    expect(platformSessionState(jwt({ exp: "not-a-number" }))).toBe("usable");
    expect(platformSessionState("opaque-casdoor-token")).toBe("usable");
    expect(platformSessionState("a.b")).toBe("usable");
    expect(platformSessionState("x.!!!.y")).toBe("usable");
  });
});
