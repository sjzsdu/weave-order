import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";
import { PlatformError } from "../src/domain/errors";
import type { Env } from "../src/env";
import { assertPlatformClaims, createOidcVerifier } from "../src/auth/claims";

/**
 * 平台端 MFA 声明兼容回归测试。
 * 覆盖两条可证明路径（标准声明 / audience 级信任）以及所有被明确禁止的放宽。
 */

const ISSUER = "https://sso.example.test";
const PLATFORM_AUD = "weave-platform";
const OTHER_AUD = "weave-order";

type Policy = Parameters<typeof assertPlatformClaims>[1];

const requireMfa = (overrides: Partial<Policy> = {}): Policy => ({
  requireMfa: true,
  trustAudience: false,
  platformAudience: PLATFORM_AUD,
  ...overrides,
});

function expectForbidden(fn: () => void): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PlatformError);
  const platformError = caught as PlatformError;
  expect(platformError.code).toBe("FORBIDDEN");
  expect(platformError.status).toBe(403);
}

describe("assertPlatformClaims — 标准 MFA 声明兼容", () => {
  it("mfa=true 通过", () => {
    const claims = assertPlatformClaims({ sub: "admin-1", mfa: true }, requireMfa());
    expect(claims.sub).toBe("admin-1");
  });

  it('amr 含 "mfa" 通过（数组与单字符串两种形态）', () => {
    expect(assertPlatformClaims({ sub: "a", amr: ["pwd", "mfa"] }, requireMfa()).sub).toBe("a");
    expect(assertPlatformClaims({ sub: "a", amr: "mfa" }, requireMfa()).sub).toBe("a");
  });

  it('acr 含 "mfa" 通过（大小写不敏感）', () => {
    expect(assertPlatformClaims({ sub: "a", acr: "urn:example:MFA" }, requireMfa()).sub).toBe("a");
  });
});

describe("assertPlatformClaims — Casdoor 实际 token 字段组合", () => {
  const casdoorPayload = {
    sub: "uuid-user-id",
    name: "平台管理员",
    email: "admin@example.test",
    aud: PLATFORM_AUD,
    // Casdoor 常规 JWT 携带的用户配置字段，但不天然证明本次认证完成 MFA。
    preferredMfaType: "TOTP",
    mfaPhoneEnabled: false,
    mfaEmailEnabled: false,
  };

  it("只有用户 MFA 配置字段、未开 audience 信任时仍 403（不把配置当证明）", () => {
    expectForbidden(() => assertPlatformClaims(casdoorPayload, requireMfa()));
  });

  it("开启 audience 信任且 aud 精确匹配时通过", () => {
    const claims = assertPlatformClaims(
      casdoorPayload,
      requireMfa({ trustAudience: true }),
    );
    expect(claims.sub).toBe("uuid-user-id");
    expect(claims.name).toBe("平台管理员");
    expect(claims.email).toBe("admin@example.test");
  });

  it("无论是否开 audience 信任，preferredMfaType 单独出现都不能放行", () => {
    expectForbidden(() =>
      assertPlatformClaims(
        { sub: "a", preferredMfaType: "TOTP", mfaPhoneEnabled: true, aud: OTHER_AUD },
        requireMfa({ trustAudience: true }),
      ),
    );
  });
});

describe("assertPlatformClaims — 缺失/空值/错误类型", () => {
  const missingCases: Array<[string, Record<string, unknown>]> = [
    ["全部缺失", { sub: "a" }],
    ["mfa=false", { sub: "a", mfa: false }],
    ["mfa 字符串 true", { sub: "a", mfa: "true" }],
    ["mfa 数字 1", { sub: "a", mfa: 1 }],
    ["amr 空数组", { sub: "a", amr: [] }],
    ["amr 空字符串", { sub: "a", amr: "" }],
    ["amr 对象", { sub: "a", amr: { mfa: true } }],
    ["acr 空字符串", { sub: "a", acr: "" }],
    ["acr 数字", { sub: "a", acr: 123 }],
    ["acr 对象", { sub: "a", acr: { toString: () => "mfa" } }],
    ["aud 非字符串", { sub: "a", aud: 123 }],
  ];

  for (const [label, payload] of missingCases) {
    it(`${label} → 403`, () => {
      expectForbidden(() =>
        assertPlatformClaims(payload, requireMfa({ trustAudience: true })),
      );
    });
  }

  it("requireMfa=false 时无声明也可通过", () => {
    const claims = assertPlatformClaims({ sub: "a" }, requireMfa({ requireMfa: false }));
    expect(claims.sub).toBe("a");
  });

  it("sub 缺失或类型错误 → 401", () => {
    for (const payload of [{}, { sub: "" }, { sub: 42 }, { sub: {} }]) {
      let caught: unknown;
      try {
        assertPlatformClaims(payload, requireMfa());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PlatformError);
      expect((caught as PlatformError).code).toBe("UNAUTHENTICATED");
    }
  });

  it("name/email/org 错误类型时安全回退", () => {
    const claims = assertPlatformClaims(
      {
        sub: "a",
        name: 42,
        preferred_username: "login-name",
        email: { x: 1 },
        org: "",
        mfa: true,
      },
      requireMfa(),
    );
    expect(claims.name).toBe("login-name");
    expect(claims.email).toBe("a@casdoor.local");
    expect(claims.org).toBeUndefined();
  });
});

describe("assertPlatformClaims — audience 信任的严格边界", () => {
  it("aud 数组含 platform 但夹带其他受众 → 不命中，403", () => {
    expectForbidden(() =>
      assertPlatformClaims(
        { sub: "a", aud: [PLATFORM_AUD, OTHER_AUD] },
        requireMfa({ trustAudience: true }),
      ),
    );
  });

  it("aud 不匹配 → 403", () => {
    expectForbidden(() =>
      assertPlatformClaims(
        { sub: "a", aud: OTHER_AUD },
        requireMfa({ trustAudience: true }),
      ),
    );
  });

  it("platformAudience 配置为空 → 永不命中", () => {
    expectForbidden(() =>
      assertPlatformClaims(
        { sub: "a", aud: PLATFORM_AUD },
        requireMfa({ trustAudience: true, platformAudience: "" }),
      ),
    );
  });

  it("aud 单元素数组精确匹配 → 通过", () => {
    expect(
      assertPlatformClaims(
        { sub: "a", aud: [PLATFORM_AUD] },
        requireMfa({ trustAudience: true }),
      ).sub,
    ).toBe("a");
  });
});

describe("assertPlatformClaims — 社交登录拒绝不回归", () => {
  for (const field of ["idp", "identity_provider"] as const) {
    it(`${field}=wechat 即使带 mfa=true 也拒绝`, () => {
      expectForbidden(() =>
        assertPlatformClaims({ sub: "a", mfa: true, [field]: "wechat" }, requireMfa()),
      );
    });
  }

  it('amr 含 "social" 即使 mfa=true 也拒绝', () => {
    expectForbidden(() =>
      assertPlatformClaims({ sub: "a", mfa: true, amr: ["pwd", "social"] }, requireMfa()),
    );
  });

  it("audience 信任路径也受社交登录拒绝约束", () => {
    expectForbidden(() =>
      assertPlatformClaims(
        { sub: "a", aud: PLATFORM_AUD, idp: "github" },
        requireMfa({ trustAudience: true }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// verifier 层：真实签名 / JWKS / issuer / audience / 有效期
// ---------------------------------------------------------------------------

interface KeyPair {
  publicJwk: JWK;
  privateKey: KeyLike;
}

let server: Server;
let jwksPort = 0;
const keys: Record<string, KeyPair> = {};

beforeAll(async () => {
  const good = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  keys.good = { publicJwk: { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" }, privateKey: good.privateKey };
  keys.other = { publicJwk: { ...(await exportJWK(other.publicKey)), kid: "k2", alg: "RS256", use: "sig" }, privateKey: other.privateKey };

  server = createServer((req, res) => {
    const match = /^\/([^/]+)\/jwks$/.exec(req.url ?? "");
    const jwk = match ? keys[match[1]!]?.publicJwk : undefined;
    res.setHeader("Content-Type", "application/json");
    if (jwk) res.end(JSON.stringify({ keys: [jwk] }));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  jwksPort = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function verifierEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    CASDOOR_ISSUER: ISSUER,
    CASDOOR_PLATFORM_AUDIENCE: PLATFORM_AUD,
    CASDOOR_JWKS_URI: `http://127.0.0.1:${jwksPort}/good/jwks`,
    PLATFORM_REQUIRE_MFA: true,
    PLATFORM_MFA_TRUST_VIA_AUDIENCE: true,
    ...overrides,
  } as Env;
}

async function signToken(options: {
  key?: KeyLike;
  issuer?: string;
  audience?: string;
  kid?: string;
  exp?: string | number;
  claims?: Record<string, unknown>;
}): Promise<string> {
  const {
    key = keys.good!.privateKey,
    issuer = ISSUER,
    audience = PLATFORM_AUD,
    kid = "k1",
    exp = "1h",
    claims = {},
  } = options;
  return new SignJWT({ sub: "admin-1", name: "管理员", ...claims })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
}

function expectRejected(promise: Promise<unknown>, code: "UNAUTHENTICATED" | "FORBIDDEN"): Promise<void> {
  return promise.then(
    () => {
      throw new Error("期望令牌被拒绝，但通过了校验");
    },
    (error) => {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
    },
  );
}

describe("createOidcVerifier — 签名/JWKS/issuer/audience/有效期", () => {
  it("合法签名 + aud 精确匹配 → 通过 audience 级信任", async () => {
    const verify = createOidcVerifier(verifierEnv());
    const token = await signToken({});
    await expect(verify(token)).resolves.toMatchObject({ sub: "admin-1" });
  });

  it("非法签名（不同私钥、kid 不在 JWKS）→ 拒绝", async () => {
    const verify = createOidcVerifier(verifierEnv());
    const token = await signToken({ key: keys.other!.privateKey, kid: "k2" });
    await expectRejected(verify(token), "UNAUTHENTICATED");
  });

  it("issuer 不匹配 → 拒绝", async () => {
    const verify = createOidcVerifier(verifierEnv());
    const token = await signToken({ issuer: "https://evil.example.test" });
    await expectRejected(verify(token), "UNAUTHENTICATED");
  });

  it("audience 不匹配 → 拒绝", async () => {
    const verify = createOidcVerifier(verifierEnv());
    const token = await signToken({ audience: OTHER_AUD });
    await expectRejected(verify(token), "UNAUTHENTICATED");
  });

  it("过期令牌 → 拒绝", async () => {
    const verify = createOidcVerifier(verifierEnv());
    const token = await signToken({ exp: -10 });
    await expectRejected(verify(token), "UNAUTHENTICATED");
  });

  it("关闭 audience 信任后，无 MFA 声明的合法令牌 → 403", async () => {
    const verify = createOidcVerifier(verifierEnv({ PLATFORM_MFA_TRUST_VIA_AUDIENCE: false }));
    const token = await signToken({});
    await expectRejected(verify(token), "FORBIDDEN");
  });

  it("关闭 audience 信任但带标准 mfa=true → 标准声明路径独立通过", async () => {
    const verify = createOidcVerifier(verifierEnv({ PLATFORM_MFA_TRUST_VIA_AUDIENCE: false }));
    const token = await signToken({ claims: { mfa: true } });
    await expect(verify(token)).resolves.toMatchObject({ sub: "admin-1" });
  });

  it("社交登录 idp=wechat 的合法令牌 → 403（verifier 路径不回归）", async () => {
    const verify = createOidcVerifier(verifierEnv());
    const token = await signToken({ claims: { idp: "wechat" } });
    await expectRejected(verify(token), "FORBIDDEN");
  });
});
