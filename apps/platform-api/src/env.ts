import { z } from "zod";
import { DEFAULT_PLATFORM_DATABASE_URL } from "@weave-order/control-db";
import { DEV_ONBOARDING_SECRET } from "./control/onboarding-ticket";

/**
 * 控制面环境契约。
 * 生产必须 OIDC + MFA；dev 模式只接受 `dev:<sub>`，与租户端 dev 网关同构但独立进程。
 */
export const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3002),
  PLATFORM_DATABASE_URL: z.string().url().default(DEFAULT_PLATFORM_DATABASE_URL),
  PLATFORM_AUTH_MODE: z.enum(["dev", "oidc"]).default("dev"),
  PLATFORM_PUBLIC_URL: z.string().url().default("http://localhost:3003"),
  CASDOOR_ISSUER: z.string().url().default("https://sso.wnbgj.com"),
  CASDOOR_PLATFORM_CLIENT_ID: z.string().default("weave-platform"),
  CASDOOR_PLATFORM_AUDIENCE: z.string().default("weave-platform"),
  CASDOOR_JWKS_URI: z.string().url().optional(),
  PLATFORM_REQUIRE_MFA: z
    .string()
    .default("true")
    .transform((value) => value === "true" || value === "1"),
  /**
   * audience 级 MFA 信任开关（默认关闭）。
   * 开启后：aud 精确等于 CASDOOR_PLATFORM_AUDIENCE 的令牌，若签名/JWKS/issuer/有效期/
   * 社交登录校验全部通过，且平台名册 mfa_enforced 成立，则视为「来自强制 MFA 的平台入口」。
   * 这是应用级/签发入口级保证，不是认证事件级证明；启用前提见 claims.ts 注释与交付说明。
   */
  PLATFORM_MFA_TRUST_VIA_AUDIENCE: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  PLATFORM_APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  PLATFORM_BREAK_GLASS_MINUTES: z.coerce.number().int().positive().max(60).default(60),
  PLATFORM_INGEST_KEY: z.string().optional(),
  PLATFORM_CORS_ORIGIN: z.string().default("http://localhost:3003"),
  /** 租户端 Web 地址：开通链接指向它（`<WEB_APP_URL>/activate?code=...`）。 */
  WEB_APP_URL: z.string().url().default("http://localhost:3001"),
  /** 出站通知：log（默认，只记日志）或 webhook（交给网关调邮件/短信）。 */
  NOTIFY_PROVIDER: z.enum(["log", "webhook"]).default("log"),
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),
  NOTIFY_TOKEN: z.string().optional(),
  /** 支持邮箱：出现在试用提醒等对外文案里；空字符串与不配置等价。 */
  SUPPORT_EMAIL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().email().optional(),
  ),
  /** 开通链接签名密钥；必须与 apps/api 的 ONBOARDING_SECRET 相同。 */
  ONBOARDING_SECRET: z.string().min(32).default(DEV_ONBOARDING_SECRET),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`控制面环境变量非法：\n${issues.join("\n")}`);
  }
  if (parsed.data.NODE_ENV === "production") {
    if (parsed.data.PLATFORM_AUTH_MODE === "dev") {
      throw new Error(
        "生产环境禁止 PLATFORM_AUTH_MODE=dev；必须使用 Casdoor OIDC（weave-platform）",
      );
    }
    assertProductionDatabaseUrl(env);
    if (parsed.data.ONBOARDING_SECRET === DEV_ONBOARDING_SECRET) {
      throw new Error(
        "生产环境必须显式配置 ONBOARDING_SECRET（≥32 字节随机值，与控制面/租户端保持一致）；否则任何人都能伪造开通链接。",
      );
    }
  }
  return parsed.data;
}

/**
 * 生产门控：控制面库必须显式配置，且不能沿用本地默认值。
 * 单租户平台数据虽不涉及 RLS，但误连 dev 默认库会直接污染真实账单与审计。
 */
export function assertProductionDatabaseUrl(env: NodeJS.ProcessEnv): void {
  const url = env.PLATFORM_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "生产环境必须显式配置 PLATFORM_DATABASE_URL（控制面独立库），不能使用本地默认值",
    );
  }
  if (url === DEFAULT_PLATFORM_DATABASE_URL) {
    throw new Error(
      "生产环境禁止使用本地默认 PLATFORM_DATABASE_URL（weave:weave@localhost/weave_platform）",
    );
  }
}
