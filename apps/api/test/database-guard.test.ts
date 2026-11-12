import { describe, expect, it } from "vitest";
import { assertNonBypassRole, resolveAppDatabaseUrl } from "../src/platform/database-guard";
import type { Env } from "../src/platform/env";

const base: Pick<Env, "DATABASE_URL" | "APP_DATABASE_URL" | "NODE_ENV" | "AUTH_MODE"> = {
  DATABASE_URL: "postgres://weave:weave@db:5432/weave_order",
  APP_DATABASE_URL: undefined,
  NODE_ENV: "development",
  AUTH_MODE: "dev",
};

describe("业务连接池启动守卫", () => {
  it("本地 dev 未配置 APP_DATABASE_URL 时回退 owner 并标记告警", () => {
    const resolved = resolveAppDatabaseUrl(base);
    expect(resolved).toMatchObject({
      url: base.DATABASE_URL,
      requiresRoleCheck: false,
      fellBackToOwner: true,
    });
  });

  it("生产未配置 APP_DATABASE_URL → 拒绝启动", () => {
    expect(() =>
      resolveAppDatabaseUrl({ ...base, NODE_ENV: "production", AUTH_MODE: "oidc" }),
    ).toThrow(/APP_DATABASE_URL/);
  });

  it("OIDC 模式（即使非 production）未配置 APP_DATABASE_URL → 拒绝启动", () => {
    expect(() => resolveAppDatabaseUrl({ ...base, AUTH_MODE: "oidc" })).toThrow(/APP_DATABASE_URL/);
  });

  it("显式配置业务 URL 时必须做角色断言", () => {
    const resolved = resolveAppDatabaseUrl({
      ...base,
      APP_DATABASE_URL: "postgres://weave_app:secret@db:5432/weave_order",
    });
    expect(resolved).toMatchObject({
      url: "postgres://weave_app:secret@db:5432/weave_order",
      requiresRoleCheck: true,
      fellBackToOwner: false,
    });
  });

  it("SUPERUSER / BYPASSRLS 角色一律拒绝", () => {
    expect(() =>
      assertNonBypassRole({ rolname: "weave", rolsuper: true, rolbypassrls: false }),
    ).toThrow(/SUPERUSER/);
    expect(() =>
      assertNonBypassRole({ rolname: "weave_sneaky", rolsuper: false, rolbypassrls: true }),
    ).toThrow(/BYPASSRLS/);
  });

  it("weave_app 角色通过", () => {
    expect(() =>
      assertNonBypassRole({ rolname: "weave_app", rolsuper: false, rolbypassrls: false }),
    ).not.toThrow();
  });
});
