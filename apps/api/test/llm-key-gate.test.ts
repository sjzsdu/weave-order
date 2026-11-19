import { describe, expect, it } from "vitest";
import { DEV_LLM_API_KEY, loadEnv } from "../src/platform/env";

const RANDOM_SECRET = "a".repeat(64);
const base = {
  QUOTE_SHARE_SECRET: RANDOM_SECRET,
  PRINT_AGENT_SECRET: RANDOM_SECRET,
  PERSONAL_TOKEN_PEPPER: RANDOM_SECRET,
  ONBOARDING_SECRET: RANDOM_SECRET,
  S3_ACCESS_KEY_ID: "prod-s3-key",
  S3_SECRET_ACCESS_KEY: "prod-s3-secret",
  // WAN-130：生产态另外五个必需项（站点域名 / path-style / 控制面 / 通知通道）。
  PUBLIC_APP_URL: "https://quote.example.com",
  WEB_APP_URL: "https://app.example.com",
  S3_FORCE_PATH_STYLE: "false",
  PLATFORM_API_URL: "https://platform.example.com",
  NOTIFY_PROVIDER: "webhook",
  NOTIFY_WEBHOOK_URL: "https://notify.example.com/send",
} as const;

const prod = {
  ...base,
  NODE_ENV: "production" as const,
  AUTH_MODE: "oidc" as const,
  LLM_PROVIDER: "openai-compatible" as const,
};

describe("openai-compatible 企业网关的生产门控（与 QUOTE_SHARE_SECRET 同一处）", () => {
  it("生产态 + openai-compatible 缺 LLM_BASE_URL → 拒绝启动", () => {
    expect(() => loadEnv({ ...prod, LLM_API_KEY: "sk-production" })).toThrow(/LLM_BASE_URL/);
  });

  it("生产态 baseUrl 指向本机也拒绝启动（不是企业网关地址）", () => {
    expect(() =>
      loadEnv({ ...prod, LLM_BASE_URL: "http://localhost:4000/v1", LLM_API_KEY: "sk-production" }),
    ).toThrow(/LLM_BASE_URL/);
  });

  it("生产态 + openai-compatible 缺 Key / 占位 Key → 拒绝启动", () => {
    expect(() => loadEnv({ ...prod, LLM_BASE_URL: "https://gw.example.com/v1" })).toThrow(
      /LLM_API_KEY/,
    );
    for (const key of [DEV_LLM_API_KEY, "<由用户手填>", "change-me"]) {
      expect(() =>
        loadEnv({ ...prod, LLM_BASE_URL: "https://gw.example.com/v1", LLM_API_KEY: key }),
      ).toThrow(/LLM_API_KEY/);
    }
  });

  it("生产态填齐通用配置后通过", () => {
    const env = loadEnv({
      ...prod,
      LLM_BASE_URL: "https://gw.example.com/v1",
      LLM_API_KEY: "sk-production",
    });
    expect(env.LLM_PROVIDER).toBe("openai-compatible");
    expect(env.LLM_BASE_URL).toBe("https://gw.example.com/v1");
    expect(env.LLM_API_KEY).toBe("sk-production");
  });

  it("local-rule 模式不因缺网关配置阻断启动", () => {
    const env = loadEnv({ ...base, NODE_ENV: "production", AUTH_MODE: "oidc" });
    expect(env.LLM_PROVIDER).toBe("local-rule");
    expect(env.LLM_BASE_URL).toBeUndefined();
    expect(env.LLM_API_KEY).toBeUndefined();
  });

  it("本地 dev 不因占位 key 或缺失配置阻断开发启动", () => {
    const env = loadEnv({
      NODE_ENV: "development",
      LLM_PROVIDER: "openai-compatible",
      LLM_API_KEY: DEV_LLM_API_KEY,
    });
    expect(env.LLM_API_KEY).toBe(DEV_LLM_API_KEY);
    expect(loadEnv({ NODE_ENV: "development" }).LLM_BASE_URL).toBeUndefined();
  });
});
