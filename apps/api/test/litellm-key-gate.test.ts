import { describe, expect, it } from "vitest";
import { DEV_LITELLM_MASTER_KEY, loadEnv } from "../src/platform/env";

const RANDOM_SECRET = "a".repeat(64);
const base = {
  QUOTE_SHARE_SECRET: RANDOM_SECRET,
  PRINT_AGENT_SECRET: RANDOM_SECRET,
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
