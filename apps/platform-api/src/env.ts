import { z } from "zod";
import { DEFAULT_PLATFORM_DATABASE_URL } from "@weave-order/control-db";

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
  PLATFORM_APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  PLATFORM_BREAK_GLASS_MINUTES: z.coerce.number().int().positive().max(60).default(60),
  PLATFORM_INGEST_KEY: z.string().optional(),
  PLATFORM_CORS_ORIGIN: z.string().default("http://localhost:3003"),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`控制面环境变量非法：\n${issues.join("\n")}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.PLATFORM_AUTH_MODE === "dev") {
    throw new Error("生产环境禁止 PLATFORM_AUTH_MODE=dev；必须使用 Casdoor OIDC（weave-platform）");
  }
  return parsed.data;
}
