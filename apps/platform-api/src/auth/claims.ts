import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { PlatformError, forbidden } from "../domain/errors";
import type { Env } from "../env";

export interface PlatformClaims {
  sub: string;
  name: string;
  email: string;
  org?: string;
}

/** 社交登录来源（Casdoor `idp` / `amr`）：平台端一律拒绝。 */
const SOCIAL_IDPS = new Set(["wechat", "qq", "github", "google", "facebook", "weibo", "dingtalk"]);

interface JwtPayloadLike {
  sub?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  org?: string;
  amr?: string[] | string;
  acr?: string;
  mfa?: boolean;
  idp?: string;
  identity_provider?: string;
}

export function claimsFromDevToken(token: string): PlatformClaims {
  const match = /^dev:([A-Za-z0-9._-]+)$/.exec(token);
  if (!match?.[1]) throw new PlatformError("UNAUTHENTICATED", "dev 令牌格式应为 dev:<sub>", 401);
  return { sub: match[1], name: match[1], email: `${match[1]}@local` };
}

/**
 * 平台令牌校验：MFA 必须成立，社交登录一律拒绝。
 * Casdoor 常见形态：`amr: ["pwd","mfa"]` 或 `mfa: true`；两者任一即可。
 */
export function assertPlatformClaims(payload: JwtPayloadLike, requireMfa: boolean): PlatformClaims {
  if (!payload.sub) throw new PlatformError("UNAUTHENTICATED", "令牌缺少 sub", 401);
  const amr = Array.isArray(payload.amr) ? payload.amr : payload.amr ? [payload.amr] : [];
  const idp = (payload.idp ?? payload.identity_provider ?? "").toLowerCase();
  if (SOCIAL_IDPS.has(idp) || amr.includes("social")) {
    throw forbidden("平台总管理端禁止社交登录，请使用账号密码 + MFA");
  }
  const mfa = payload.mfa === true || amr.includes("mfa") || (payload.acr ?? "").includes("mfa");
  if (requireMfa && !mfa) {
    throw forbidden("平台总管理端强制 MFA：令牌未包含 MFA 声明");
  }
  return {
    sub: payload.sub,
    name: payload.name ?? payload.preferred_username ?? payload.sub,
    email: payload.email ?? `${payload.sub}@casdoor.local`,
    org: payload.org,
  };
}

export function createOidcVerifier(env: Env): (token: string) => Promise<PlatformClaims> {
  const jwksUri =
    env.CASDOOR_JWKS_URI ?? `${env.CASDOOR_ISSUER.replace(/\/$/, "")}/.well-known/jwks`;
  let jwks: JWTVerifyGetKey | null = null;
  return async (token) => {
    jwks ??= createRemoteJWKSet(new URL(jwksUri));
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: env.CASDOOR_ISSUER,
        audience: env.CASDOOR_PLATFORM_AUDIENCE,
      });
      return assertPlatformClaims(payload, env.PLATFORM_REQUIRE_MFA);
    } catch (cause) {
      if (cause instanceof PlatformError) throw cause;
      throw new PlatformError(
        "UNAUTHENTICATED",
        `平台令牌校验失败：${cause instanceof Error ? cause.message : "unknown"}`,
        401,
      );
    }
  };
}
