import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { AuthClaims } from "@weave-order/schema";

/**
 * OIDC 令牌校验。
 *
 * Casdoor 是唯一身份源：这里只做 RS256/JWKS 验签与 issuer/audience/exp 校验，
 * 不做任何角色判断；角色与租户一律回到本地 memberships 查。
 */
export interface TokenVerifier {
  verify(token: string): Promise<AuthClaims>;
}

export interface OidcConfig {
  issuer: string;
  audience: string;
  /** 缺省时按 `${issuer}/.well-known/jwks` 推导。 */
  jwksUri?: string;
}

interface CasdoorClaims {
  sub?: unknown;
  org?: unknown;
  orgName?: unknown;
  name?: unknown;
  email?: unknown;
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createCasdoorVerifier(
  config: OidcConfig,
  /** 测试可注入本地 JWKS；生产不传，走远程。 */
  keySet?: JWTVerifyGetKey,
): TokenVerifier {
  const issuer = config.issuer.replace(/\/$/, "");
  const jwks =
    keySet ?? createRemoteJWKSet(new URL(config.jwksUri ?? `${issuer}/.well-known/jwks`));
  return {
    async verify(token: string): Promise<AuthClaims> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: config.audience,
        clockTolerance: 5,
      });
      const claims = payload as CasdoorClaims;
      const sub = stringClaim(claims.sub);
      if (!sub) {
        throw new Error("令牌缺少 sub");
      }
      const exp = typeof payload.exp === "number" ? payload.exp : 0;
      if (exp <= 0) {
        throw new Error("令牌缺少 exp");
      }
      return AuthClaims.parse({
        sub,
        org: stringClaim(claims.org) ?? stringClaim(claims.orgName),
        name: stringClaim(claims.name),
        email: stringClaim(claims.email),
        issuer,
        audience: config.audience,
        expiresAt: exp,
      });
    },
  };
}

/**
 * 仅开发/测试可用的静态令牌：`Authorization: Bearer dev:<sub>:<org>`。
 * 生产环境（AUTH_MODE=oidc 或 NODE_ENV=production）下永远不会被装配。
 */
export function createDevVerifier(): TokenVerifier {
  return {
    verify(token: string): Promise<AuthClaims> {
      const [prefix, sub, org] = token.split(":");
      if (prefix !== "dev" || !sub) {
        return Promise.reject(new Error("非法的开发令牌格式"));
      }
      return Promise.resolve(
        AuthClaims.parse({
          sub,
          org: org ?? null,
          name: sub,
          email: `${sub}@dev.local`,
          issuer: "dev",
          audience: "dev",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      );
    },
  };
}
