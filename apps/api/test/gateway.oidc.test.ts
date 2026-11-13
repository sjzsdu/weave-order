import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createCasdoorVerifier, createDevVerifier } from "../src/gateway/oidc";

const ISSUER = "https://sso.example.test";
const AUDIENCE = "weave-order";

let sign: (
  claims: Record<string, unknown>,
  options?: { audience?: string; exp?: number },
) => Promise<string>;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk: JWK = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  jwks = createLocalJWKSet({ keys: [publicJwk] });
  sign = (claims, options = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(options.exp ?? now + 600);
    if (typeof claims.sub === "string") jwt.setSubject(claims.sub);
    return jwt.sign(privateKey);
  };
});

function verifier() {
  return createCasdoorVerifier({ issuer: ISSUER, audience: AUDIENCE }, jwks);
}

describe("Casdoor OIDC 令牌校验（T0 网关）", () => {
  it("校验通过时提取 sub / org / name / email", async () => {
    const token = await sign({ sub: "u-100", org: "acme", name: "张三", email: "a@b.com" });
    const claims = await verifier().verify(token);
    expect(claims).toMatchObject({
      sub: "u-100",
      org: "acme",
      name: "张三",
      email: "a@b.com",
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  });

  it("orgName 作为 org 的兜底 claim", async () => {
    const token = await sign({ sub: "u-101", orgName: "beta" });
    await expect(verifier().verify(token)).resolves.toMatchObject({ org: "beta" });
  });

  it("audience 不匹配拒绝", async () => {
    const token = await sign({ sub: "u-102" }, { audience: "other" });
    await expect(verifier().verify(token)).rejects.toThrow();
  });

  it("过期令牌拒绝", async () => {
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = await sign({ sub: "u-103" }, { exp: past });
    await expect(verifier().verify(token)).rejects.toThrow();
  });

  it("缺少 sub 拒绝", async () => {
    const token = await sign({ org: "acme" });
    await expect(verifier().verify(token)).rejects.toThrow(/sub/);
  });

  it("开发令牌只在 dev verifier 下可用", async () => {
    const claims = await createDevVerifier().verify("dev:alice:acme");
    expect(claims).toMatchObject({ sub: "alice", org: "acme" });
    await expect(createDevVerifier().verify("alice")).rejects.toThrow();
  });
});
