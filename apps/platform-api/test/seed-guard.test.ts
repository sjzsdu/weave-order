import { describe, expect, it } from "vitest";
import {
  assertSeedAllowed,
  isExplicitTestEnv,
  isSeedProductionLike,
  SeedForbiddenError,
} from "../scripts/seed-guard";

describe("控制面 seed 生产硬闸门", () => {
  it("本地 development + dev 放行", () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: "development", PLATFORM_AUTH_MODE: "dev" }),
    ).not.toThrow();
  });

  it("NODE_ENV=production 拒绝", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "production", PLATFORM_AUTH_MODE: "oidc" })).toThrow(
      SeedForbiddenError,
    );
  });

  it("PLATFORM_AUTH_MODE=oidc 即使 NODE_ENV 未设也拒绝", () => {
    expect(() => assertSeedAllowed({ PLATFORM_AUTH_MODE: "oidc" })).toThrow(SeedForbiddenError);
  });

  it("生产形态但显式 WEAVE_ENV=test 放行（CI 同构测试）", () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: "production", PLATFORM_AUTH_MODE: "oidc", WEAVE_ENV: "test" }),
    ).not.toThrow();
  });

  it("生产态判定与测试环境判定相互独立", () => {
    expect(isSeedProductionLike({ NODE_ENV: "production" })).toBe(true);
    expect(isSeedProductionLike({ PLATFORM_AUTH_MODE: "oidc" })).toBe(true);
    expect(isSeedProductionLike({ NODE_ENV: "development", PLATFORM_AUTH_MODE: "dev" })).toBe(
      false,
    );
    expect(isExplicitTestEnv({ WEAVE_ENV: "test" })).toBe(true);
    expect(isExplicitTestEnv({})).toBe(false);
  });

  it("拒绝信息可直接指引如何解封", () => {
    try {
      assertSeedAllowed({ NODE_ENV: "production" });
      throw new Error("应当抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(SeedForbiddenError);
      expect((error as Error).message).toContain("WEAVE_ENV=test");
    }
  });
});
