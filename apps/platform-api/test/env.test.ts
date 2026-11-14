import { describe, expect, it } from "vitest";
import { DEFAULT_PLATFORM_DATABASE_URL, resolvePlatformDatabaseUrl } from "@weave-order/control-db";
import { assertProductionDatabaseUrl, loadEnv } from "../src/env";

describe("控制面生产环境门控", () => {
  it("生产缺 PLATFORM_DATABASE_URL 时 fail-fast", () => {
    expect(() => loadEnv({ NODE_ENV: "production", PLATFORM_AUTH_MODE: "oidc" })).toThrow(
      /PLATFORM_DATABASE_URL/,
    );
  });

  it("生产禁止沿用本地默认库", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        PLATFORM_AUTH_MODE: "oidc",
        PLATFORM_DATABASE_URL: DEFAULT_PLATFORM_DATABASE_URL,
      }),
    ).toThrow(/本地默认/);
  });

  it("生产显式独立库可启动", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      PLATFORM_AUTH_MODE: "oidc",
      PLATFORM_DATABASE_URL: "postgres://weave:secret@db.internal:5432/weave_platform_prod",
      ONBOARDING_SECRET: "prod-onboarding-secret-0123456789abcdef",
    });
    expect(env.PLATFORM_DATABASE_URL).toContain("weave_platform_prod");
  });

  it("生产禁止使用默认开通链接密钥", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        PLATFORM_AUTH_MODE: "oidc",
        PLATFORM_DATABASE_URL: "postgres://weave:secret@db.internal:5432/weave_platform_prod",
      }),
    ).toThrow(/ONBOARDING_SECRET/);
  });

  it("生产仍然禁止 dev 鉴权", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        PLATFORM_AUTH_MODE: "dev",
        PLATFORM_DATABASE_URL: "postgres://weave:secret@db.internal:5432/weave_platform_prod",
      }),
    ).toThrow(/PLATFORM_AUTH_MODE=dev/);
  });

  it("迁移脚本在生产也不回落默认库", () => {
    expect(() => resolvePlatformDatabaseUrl({ NODE_ENV: "production" })).toThrow(
      /PLATFORM_DATABASE_URL/,
    );
    expect(
      resolvePlatformDatabaseUrl({
        NODE_ENV: "production",
        PLATFORM_DATABASE_URL: "postgres://x:y@db:5432/p",
      }),
    ).toBe("postgres://x:y@db:5432/p");
  });

  it("开发环境仍可用默认库", () => {
    expect(resolvePlatformDatabaseUrl({ NODE_ENV: "development" })).toBe(
      DEFAULT_PLATFORM_DATABASE_URL,
    );
    expect(assertProductionDatabaseUrl).toBeTypeOf("function");
  });
});
