import { describe, expect, it } from "vitest";
import { isProductionLike } from "../src/runtime-mode";

/**
 * 生产态判定是所有 fail-fast 门控的唯一入口（api 与 web 共用这一份）。
 * 表里每一行都对应一个真实部署形态；改判定前先确认这些组合的语义没有被打破。
 */
describe("isProductionLike：api/web 共用的生产态判定", () => {
  const cases: Array<{
    label: string;
    env: { NODE_ENV?: string; AUTH_MODE?: string };
    want: boolean;
  }> = [
    {
      label: "生产环境：NODE_ENV=production + AUTH_MODE=oidc",
      env: { NODE_ENV: "production", AUTH_MODE: "oidc" },
      want: true,
    },
    {
      label: "测试环境与生产同构：NODE_ENV=production + AUTH_MODE=oidc",
      env: { NODE_ENV: "production", AUTH_MODE: "oidc" },
      want: true,
    },
    {
      label: "只有 NODE_ENV=production（未配 AUTH_MODE）",
      env: { NODE_ENV: "production", AUTH_MODE: "dev" },
      want: true,
    },
    {
      label: "staging：NODE_ENV=development + AUTH_MODE=oidc",
      env: { NODE_ENV: "development", AUTH_MODE: "oidc" },
      want: true,
    },
    {
      label: "本地 dev：NODE_ENV=development + AUTH_MODE=dev",
      env: { NODE_ENV: "development", AUTH_MODE: "dev" },
      want: false,
    },
    {
      label: "CI：NODE_ENV=test + AUTH_MODE=dev",
      env: { NODE_ENV: "test", AUTH_MODE: "dev" },
      want: false,
    },
    { label: "空环境（未配置）不判为生产态", env: {}, want: false },
  ];

  for (const { label, env, want } of cases) {
    it(`${label} → ${want}`, () => {
      expect(isProductionLike(env)).toBe(want);
    });
  }

  it("默认读 process.env：NODE_ENV 与 AUTH_MODE 任一命中即生产态", () => {
    const original = { NODE_ENV: process.env.NODE_ENV, AUTH_MODE: process.env.AUTH_MODE };
    try {
      process.env.NODE_ENV = "development";
      process.env.AUTH_MODE = "oidc";
      expect(isProductionLike()).toBe(true);

      process.env.NODE_ENV = "development";
      process.env.AUTH_MODE = "dev";
      expect(isProductionLike()).toBe(false);
    } finally {
      process.env.NODE_ENV = original.NODE_ENV;
      process.env.AUTH_MODE = original.AUTH_MODE;
    }
  });
});
