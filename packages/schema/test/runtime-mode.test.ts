import { describe, expect, it } from "vitest";
import {
  canResetDemoData,
  isProductionLike,
  isTestEnv,
  needsDemoResetConfirmation,
} from "../src/runtime-mode";

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

/**
 * `WEAVE_ENV` 是部署维度，不是 `NODE_ENV` 的别名。
 * 测试环境必须与生产同构（仍判为生产态），同时允许重置演示数据。
 */
describe("isTestEnv / canResetDemoData：测试环境与 demo:reset 门控", () => {
  const cases: Array<{
    label: string;
    env: { NODE_ENV?: string; AUTH_MODE?: string; WEAVE_ENV?: string };
    test: boolean;
    reset: boolean;
  }> = [
    {
      label: "本地 dev（无 WEAVE_ENV）",
      env: { NODE_ENV: "development", AUTH_MODE: "dev" },
      test: false,
      reset: true,
    },
    {
      label: "测试环境：生产同构 + WEAVE_ENV=test",
      env: { NODE_ENV: "production", AUTH_MODE: "oidc", WEAVE_ENV: "test" },
      test: true,
      reset: true,
    },
    {
      label: "生产环境：生产同构、无 WEAVE_ENV",
      env: { NODE_ENV: "production", AUTH_MODE: "oidc" },
      test: false,
      reset: false,
    },
    {
      label: "生产环境：显式 WEAVE_ENV=production",
      env: { NODE_ENV: "production", AUTH_MODE: "oidc", WEAVE_ENV: "production" },
      test: false,
      reset: false,
    },
    {
      label: "拼错的 WEAVE_ENV 按生产处理",
      env: { NODE_ENV: "production", AUTH_MODE: "oidc", WEAVE_ENV: "tset" },
      test: false,
      reset: false,
    },
  ];

  for (const { label, env, test, reset } of cases) {
    it(`${label} → isTestEnv=${test} / canResetDemoData=${reset}`, () => {
      expect(isTestEnv(env)).toBe(test);
      expect(canResetDemoData(env)).toBe(reset);
    });
  }
});

/**
 * 第二道门：测试环境与生产只差 `WEAVE_ENV=test` 一个变量，误拷 `.env.test`
 * 就能清库。所以生产态下的重置必须再显式确认一次，本地 dev 不需要。
 */
describe("needsDemoResetConfirmation：生产态重置的二次确认", () => {
  const cases: Array<{
    label: string;
    env: { NODE_ENV?: string; AUTH_MODE?: string; WEAVE_ENV?: string; DEMO_RESET_CONFIRM?: string };
    want: boolean;
  }> = [
    {
      label: "本地 dev：不要求确认",
      env: { NODE_ENV: "development", AUTH_MODE: "dev" },
      want: false,
    },
    {
      label: "本地 dev 即使带 WEAVE_ENV=test（配置错误组合）也仍按非生产态处理",
      env: { NODE_ENV: "development", AUTH_MODE: "dev", WEAVE_ENV: "test" },
      want: false,
    },
    {
      label: "测试环境：未带 DEMO_RESET_CONFIRM → 要求确认",
      env: { NODE_ENV: "production", AUTH_MODE: "oidc", WEAVE_ENV: "test" },
      want: true,
    },
    {
      label: "测试环境：DEMO_RESET_CONFIRM=0 → 仍然拒绝",
      env: {
        NODE_ENV: "production",
        AUTH_MODE: "oidc",
        WEAVE_ENV: "test",
        DEMO_RESET_CONFIRM: "0",
      },
      want: true,
    },
    {
      label: "测试环境：DEMO_RESET_CONFIRM=1 → 放行",
      env: {
        NODE_ENV: "production",
        AUTH_MODE: "oidc",
        WEAVE_ENV: "test",
        DEMO_RESET_CONFIRM: "1",
      },
      want: false,
    },
    {
      label: "生产环境：第一次门就拒了，确认值不影响",
      env: { NODE_ENV: "production", AUTH_MODE: "oidc", DEMO_RESET_CONFIRM: "1" },
      want: false,
    },
  ];

  for (const { label, env, want } of cases) {
    it(`${label} → ${want}`, () => {
      expect(needsDemoResetConfirmation(env)).toBe(want);
    });
  }
});
