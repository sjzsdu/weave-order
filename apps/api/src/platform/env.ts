import { z } from "zod";

/**
 * 运行时环境变量契约。
 * 默认值与 docker-compose.yml 一致，因此本地 `docker compose up` 后
 * 不需要 .env 也能跑通；线上用环境变量覆盖。
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://weave:weave@localhost:5433/weave_order"),
  /** 网关业务连接：生产必须是 weave_app（无 BYPASSRLS）；本地缺省沿用 DATABASE_URL。 */
  APP_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default("redis://localhost:6380"),
  /** embedding provider：local-stub（默认，无需外部 key） */
  EMBEDDING_PROVIDER: z.string().min(1).default("local-stub"),
  /** 智能体 LLM provider：local-rule（默认，确定性规则，无需 key） */
  LLM_PROVIDER: z.string().min(1).default("local-rule"),
  /** LLM 网关（LiteLLM，OpenAI 兼容）；agent 只认这个地址，不直连厂商。 */
  LITELLM_BASE_URL: z.string().url().default("http://localhost:4000"),
  LITELLM_MASTER_KEY: z.string().min(1).default("sk-local-dev"),
  /** 单次调用超时（毫秒）。 */
  LITELLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** 物流 provider：local-deterministic（默认，本地确定性） */
  LOGISTICS_PROVIDER: z.string().min(1).default("local-deterministic"),
  /** 客户回复来源：local-scripted（默认，便于演示与测试） */
  REPLY_SOURCE: z.string().min(1).default("local-scripted"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** dev：接受 `Bearer dev:<sub>:<org>`（仅本地）；oidc：Casdoor JWKS 验签。 */
  AUTH_MODE: z.enum(["dev", "oidc"]).default("dev"),
  CASDOOR_ISSUER: z.string().url().default("https://sso.wnbgj.com"),
  CASDOOR_AUDIENCE: z.string().min(1).default("weave-order"),
  CASDOOR_JWKS_URI: z.string().url().optional(),
  /** 客户报价分享链接的站点根地址。 */
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5174"),
  /** 客户报价链接的 HMAC 密钥；生产必须覆盖为 ≥32 字节随机值。 */
  QUOTE_SHARE_SECRET: z.string().min(32).default("dev-only-quote-share-secret-change-me-0001"),
  /** T-001 imageUrl 变体允许取图的对象存储 / CDN 域名（逗号分隔）。 */
  MEDIA_ALLOWED_HOSTS: z.string().default(""),
  /** 按 URL 取图的最大字节数（默认 2MB，上限 10MB）。 */
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(10_000_000).default(2_000_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
