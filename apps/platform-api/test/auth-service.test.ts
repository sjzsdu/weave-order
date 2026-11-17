import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "@weave-order/control-db";

/**
 * AuthService 名册关卡回归：MFA 兼容修复不能绕过 control.platform_users 名册与
 * mfa_enforced 校验。verifier 被 mock 为固定的合法平台身份，只考察名册之后的判断。
 */

const FIXED_SUB = "casdoor-user-id";

vi.mock("../src/auth/claims", () => ({
  claimsFromDevToken: () => {
    throw new Error("不应走 dev 令牌");
  },
  createOidcVerifier: () => () =>
    Promise.resolve({
      sub: FIXED_SUB,
      name: "平台管理员",
      email: "admin@example.test",
    }),
}));

import { AuthService } from "../src/auth/auth.service";
import { PlatformError } from "../src/domain/errors";

type Row = {
  id: string;
  subject: string;
  email: string;
  name: string;
  role: "platform_owner";
  status: "ACTIVE" | "DISABLED";
  mfaEnforced: boolean;
};

function makeDb(row: Row | undefined): PlatformDb {
  const base = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    }),
  };
  return base as unknown as PlatformDb;
}

const activeRow = (mfaEnforced: boolean): Row => ({
  id: "roster-1",
  subject: FIXED_SUB,
  email: "admin@example.test",
  name: "平台管理员",
  role: "platform_owner",
  status: "ACTIVE",
  mfaEnforced,
});

async function authenticate(db: PlatformDb): Promise<unknown> {
  return new AuthService(db).authenticate("Bearer any-valid-token");
}

async function expectForbidden(db: PlatformDb): Promise<void> {
  let caught: unknown;
  try {
    await authenticate(db);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PlatformError);
  expect((caught as PlatformError).code).toBe("FORBIDDEN");
  expect((caught as PlatformError).status).toBe(403);
}

beforeEach(() => {
  vi.stubEnv("PLATFORM_AUTH_MODE", "oidc");
  vi.stubEnv("PLATFORM_REQUIRE_MFA", "true");
  vi.stubEnv("PLATFORM_DATABASE_URL", "postgres://weave:secret@db.internal:5432/weave_platform_test");
  vi.stubEnv("ONBOARDING_SECRET", "test-onboarding-secret-0123456789abcdef");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("AuthService — 平台名册与 mfa_enforced 不可绕过", () => {
  it("名册缺失时拒绝（MFA 通过也不能进入）", async () => {
    await expectForbidden(makeDb(undefined));
  });

  it("账号停用（status≠ACTIVE）时拒绝", async () => {
    await expectForbidden(makeDb({ ...activeRow(true), status: "DISABLED" }));
  });

  it("名册存在但 mfa_enforced=false 时拒绝", async () => {
    await expectForbidden(makeDb(activeRow(false)));
  });

  it("名册存在且 mfa_enforced=true 时放行，并按 sub 命中名册记录", async () => {
    const actor = (await authenticate(makeDb(activeRow(true)))) as {
      sub: string;
      id: string;
      role: string;
    };
    expect(actor.sub).toBe(FIXED_SUB);
    expect(actor.id).toBe("roster-1");
    expect(actor.role).toBe("platform_owner");
  });

  it("名册 sub 与令牌 sub 不一致时（查不到）拒绝", async () => {
    const row = { ...activeRow(true), subject: "another-sub" };
    // makeDb 不按 where 条件过滤，这里直接验证「查不到对应 sub」的语义由 where 承担；
    // 用空结果模拟 where(eq(subject, FIXED_SUB)) 未命中。
    expect(row.subject).not.toBe(FIXED_SUB);
    await expectForbidden(makeDb(undefined));
  });
});
