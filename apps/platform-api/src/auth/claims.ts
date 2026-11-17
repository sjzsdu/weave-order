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

/**
 * 令牌中参与判定的字段一律按 unknown 取入，经过类型守卫后才使用。
 * 任意类型（字符串/数字/对象/null）都不会被误判为 MFA 成立。
 */
interface JwtPayloadLike {
  sub?: unknown;
  name?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  org?: unknown;
  aud?: unknown;
  amr?: unknown;
  acr?: unknown;
  mfa?: unknown;
  idp?: unknown;
  identity_provider?: unknown;
  /** Casdoor 用户配置字段：仅声明其存在，断言逻辑刻意不读取它们作为 MFA 证据。 */
  preferredMfaType?: unknown;
  mfaPhoneEnabled?: unknown;
  mfaEmailEnabled?: unknown;
}

export function claimsFromDevToken(token: string): PlatformClaims {
  const match = /^dev:([A-Za-z0-9._-]+)$/.exec(token);
  if (!match?.[1]) throw new PlatformError("UNAUTHENTICATED", "dev 令牌格式应为 dev:<sub>", 401);
  return { sub: match[1], name: match[1], email: `${match[1]}@local` };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** amr 只接受「字符串数组」或「单个字符串」，其余类型一律视为空。 */
function normalizeAmr(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/**
 * aud 只接受单个字符串或字符串数组；audience 级信任要求精确单项匹配，
 * 不接受「数组里包含 platform audience 但还夹带其他受众」的宽泛令牌。
 */
function audienceExactly(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  if (Array.isArray(value)) return value.length === 1 && value[0] === expected;
  return false;
}

interface MfaEvidence {
  /** 令牌自带的标准 MFA 声明：mfa=true / amr 含 "mfa" / acr 含 "mfa"。 */
  standard: boolean;
  /**
   * audience 级信任命中：aud 精确等于平台应用 audience。
   * 这是「签发入口级」保证——该入口在部署侧配置了用户级 Required TOTP 且禁用 remember，
   * 不是对 preferredMfaType 等用户配置字段的解读，也不是认证事件级证明。
   */
  audienceTrusted: boolean;
}

function hasStandardMfa(payload: JwtPayloadLike): boolean {
  if (payload.mfa === true) return true;
  const amr = normalizeAmr(payload.amr);
  if (amr.some((item) => item.toLowerCase() === "mfa")) return true;
  const acr = nonEmptyString(payload.acr);
  return acr !== undefined && acr.toLowerCase().includes("mfa");
}

export interface ClaimPolicy {
  requireMfa: boolean;
  /** 显式开启 audience 级信任；未开启时该路径永远不成立。 */
  trustAudience: boolean;
  /** 被信任的平台 audience（精确匹配）。 */
  platformAudience: string;
}

/**
 * 平台令牌校验：MFA 必须成立，社交登录一律拒绝。
 *
 * MFA 成立的两条可证明路径（任一即可）：
 *   1. standard —— 令牌自带标准 mfa/amr/acr 声明；
 *   2. audienceTrusted —— 显式开启 audience 信任，且 aud 精确等于 weave-platform。
 *
 * 【安全语义 / 信任边界，务必与交付说明一致】
 * - 路径 2 信任的是「签发入口」而非「认证事件」：Casdoor 常规 id_token 不含 mfa/amr/acr，
 *   只有 aud=weave-platform 才证明该令牌来自部署侧配置了用户级 Required TOTP、
 *   mfaRememberInHours=0、且禁止社交登录的**平台管理端唯一入口**。
 * - preferredMfaType / mfaPhoneEnabled / mfaEmailEnabled 只是用户的 MFA **配置状态**，
 *   不能证明本次认证完成 MFA，因此本函数完全不读取它们作为证据。
 * - 信任仅限平台管理端：本策略只由 createOidcVerifier（platform-api）使用，租户端不启用。
 * - 旧令牌 / 既有 SSO 会话：audience 级信任无法区分「本次登录是否实际输入了 TOTP」，
 *   因此必须依赖部署前提——平台应用强制 Required TOTP、禁用 remember、 shortening token TTL，
 *   并在切换策略时使存量令牌失效（见交付说明的部署验收步骤）。若这些前提不成立，
 *   应关闭 PLATFORM_MFA_TRUST_VIA_AUDIENCE，保持对无声明令牌的 403。
 * - 无论哪条路径，签名/JWKS/issuer/audience/有效期、社交登录拒绝、
 *   control.platform_users 名册与 mfa_enforced 校验都不可绕过。
 */
export function assertPlatformClaims(
  payload: JwtPayloadLike,
  policy: ClaimPolicy,
): PlatformClaims {
  const sub = nonEmptyString(payload.sub);
  if (!sub) throw new PlatformError("UNAUTHENTICATED", "令牌缺少 sub 或 sub 类型错误", 401);

  const amr = normalizeAmr(payload.amr);
  const idp = (nonEmptyString(payload.idp) ?? nonEmptyString(payload.identity_provider) ?? "").toLowerCase();
  if (SOCIAL_IDPS.has(idp) || amr.some((item) => item.toLowerCase() === "social")) {
    throw forbidden("平台总管理端禁止社交登录，请使用账号密码 + MFA");
  }

  const evidence: MfaEvidence = {
    standard: hasStandardMfa(payload),
    audienceTrusted:
      policy.trustAudience &&
      nonEmptyString(policy.platformAudience) !== undefined &&
      audienceExactly(payload.aud, policy.platformAudience),
  };
  if (policy.requireMfa && !evidence.standard && !evidence.audienceTrusted) {
    throw forbidden("平台总管理端强制 MFA：令牌未包含 MFA 声明");
  }
  return {
    sub,
    name: nonEmptyString(payload.name) ?? nonEmptyString(payload.preferred_username) ?? sub,
    email: nonEmptyString(payload.email) ?? `${sub}@casdoor.local`,
    org: nonEmptyString(payload.org),
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
      return assertPlatformClaims(payload, {
        requireMfa: env.PLATFORM_REQUIRE_MFA,
        trustAudience: env.PLATFORM_MFA_TRUST_VIA_AUDIENCE,
        platformAudience: env.CASDOOR_PLATFORM_AUDIENCE,
      });
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
