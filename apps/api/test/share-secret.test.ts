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
      PRINT_AGENT_SECRET: RANDOM_SECRET,
      PERSONAL_TOKEN_PEPPER: RANDOM_SECRET,
      ONBOARDING_SECRET: RANDOM_SECRET,
      S3_ACCESS_KEY_ID: "prod-s3-key",
      S3_SECRET_ACCESS_KEY: "prod-s3-secret",
      // WAN-130：链接域名 / path-style / 控制面 / 通知通道同样是生产必需项。
      PUBLIC_APP_URL: "https://quote.example.com",
      WEB_APP_URL: "https://app.example.com",
      S3_FORCE_PATH_STYLE: "false",
      PLATFORM_API_URL: "https://platform.example.com",
      NOTIFY_PROVIDER: "webhook",
      NOTIFY_WEBHOOK_URL: "https://notify.example.com/send",
    });
    expect(env.QUOTE_SHARE_SECRET).toBe(RANDOM_SECRET);
    expect(env.PRINT_AGENT_SECRET).toBe(RANDOM_SECRET);
  });

  it("打印代理 token 密钥同样有生产门控", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        QUOTE_SHARE_SECRET: RANDOM_SECRET,
        PERSONAL_TOKEN_PEPPER: RANDOM_SECRET,
      }),
    ).toThrow(/PRINT_AGENT_SECRET/);
  });

  it("个人访问凭据 pepper 同样有生产门控（WAN-78）", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        QUOTE_SHARE_SECRET: RANDOM_SECRET,
        PRINT_AGENT_SECRET: RANDOM_SECRET,
      }),
    ).toThrow(/PERSONAL_TOKEN_PEPPER/);
  });

  it("开通链接密钥同样有生产门控（WAN-110）", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        QUOTE_SHARE_SECRET: RANDOM_SECRET,
        PRINT_AGENT_SECRET: RANDOM_SECRET,
        PERSONAL_TOKEN_PEPPER: RANDOM_SECRET,
      }),
    ).toThrow(/ONBOARDING_SECRET/);
  });

  it("太短的 secret 仍被 env 契约拒绝", () => {
    expect(() => loadEnv({ NODE_ENV: "production", QUOTE_SHARE_SECRET: "too-short" })).toThrow();
  });

  it("对象存储凭证同样有生产门控（WAN-116）", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        AUTH_MODE: "oidc",
        QUOTE_SHARE_SECRET: RANDOM_SECRET,
        PRINT_AGENT_SECRET: RANDOM_SECRET,
        PERSONAL_TOKEN_PEPPER: RANDOM_SECRET,
        ONBOARDING_SECRET: RANDOM_SECRET,
      }),
    ).toThrow(/S3_ACCESS_KEY_ID/);
  });
});
