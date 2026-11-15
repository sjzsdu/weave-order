import { describe, expect, it } from "vitest";
import { DEV_LITELLM_MASTER_KEY, loadEnv } from "../src/platform/env";

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

describe("LiteLLM key 的生产门控（与 QUOTE_SHARE_SECRET 同一处）", () => {
  it("生产态 + litellm + 默认 key → 拒绝启动", () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: "production", AUTH_MODE: "oidc", LLM_PROVIDER: "litellm" }),
    ).toThrow(/LITELLM_MASTER_KEY/);
    expect(() =>
      loadEnv({ ...base, NODE_ENV: "development", AUTH_MODE: "oidc", LLM_PROVIDER: "litellm" }),
    ).toThrow(/LITELLM_MASTER_KEY/);
  });

  it("local-rule 模式不因默认 key 阻断启动", () => {
    const env = loadEnv({ ...base, NODE_ENV: "production", AUTH_MODE: "oidc" });
    expect(env.LLM_PROVIDER).toBe("local-rule");
    expect(env.LITELLM_MASTER_KEY).toBe(DEV_LITELLM_MASTER_KEY);
  });

  it("显式配置 key 后可通过", () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: "production",
      AUTH_MODE: "oidc",
      LLM_PROVIDER: "litellm",
      LITELLM_MASTER_KEY: "sk-production",
    });
    expect(env.LITELLM_MASTER_KEY).toBe("sk-production");
  });

  it("本地 dev 仍允许占位 key（零配置演示）", () => {
    const env = loadEnv({ NODE_ENV: "development", LLM_PROVIDER: "litellm" });
    expect(env.LITELLM_MASTER_KEY).toBe(DEV_LITELLM_MASTER_KEY);
  });
});
