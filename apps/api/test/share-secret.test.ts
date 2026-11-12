import { describe, expect, it } from "vitest";
import { DEV_QUOTE_SHARE_SECRET, loadEnv } from "../src/platform/env";

const RANDOM_SECRET = "a".repeat(64);

describe("报价链接密钥的生产门控", () => {
  it("本地/测试允许使用占位 secret", () => {
    expect(() => loadEnv({ NODE_ENV: "development" })).not.toThrow();
    expect(loadEnv({ NODE_ENV: "test" }).QUOTE_SHARE_SECRET).toBe(DEV_QUOTE_SHARE_SECRET);
  });

  it("生产使用默认 secret 直接拒绝启动（fail-fast）", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/QUOTE_SHARE_SECRET/);
    expect(() => loadEnv({ NODE_ENV: "production", AUTH_MODE: "oidc" })).toThrow(
      /QUOTE_SHARE_SECRET/,
    );
  });

  it("OIDC 模式同样要求显式 secret", () => {
    expect(() => loadEnv({ NODE_ENV: "development", AUTH_MODE: "oidc" })).toThrow(
      /QUOTE_SHARE_SECRET/,
    );
  });

  it("生产显式配置 ≥32 字节随机值即可通过", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      AUTH_MODE: "oidc",
      QUOTE_SHARE_SECRET: RANDOM_SECRET,
    });
    expect(env.QUOTE_SHARE_SECRET).toBe(RANDOM_SECRET);
  });

  it("太短的 secret 仍被 env 契约拒绝", () => {
    expect(() => loadEnv({ NODE_ENV: "production", QUOTE_SHARE_SECRET: "too-short" })).toThrow();
  });
});
