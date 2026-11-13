import { z } from "zod";
import { isProductionLike } from "./runtime-mode";

/** 仅本地/测试使用的占位密钥；生产出现即 fail-fast（与 database-guard 同一策略）。 */
export const DEV_QUOTE_SHARE_SECRET = "dev-only-quote-share-secret-change-me-0001";

/** 仅本地/测试使用的 LiteLLM 占位 key；生产 + litellm provider 时拒绝启动。 */
export const DEV_LITELLM_MASTER_KEY = "sk-local-dev";

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
  LITELLM_MASTER_KEY: z.string().min(1).default(DEV_LITELLM_MASTER_KEY),
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
  QUOTE_SHARE_SECRET: z.string().min(32).default(DEV_QUOTE_SHARE_SECRET),
  /** T-001 imageUrl 变体允许取图的对象存储 / CDN 域名（逗号分隔）。 */
  MEDIA_ALLOWED_HOSTS: z.string().default(""),
  /** 按 URL 取图的最大字节数（默认 2MB，上限 10MB）。 */
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(10_000_000).default(2_000_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(source);
  // 与 APP_DATABASE_URL 的生产硬校验同一原则：生产/OIDC 模式不允许静默使用公开占位密钥。
  // 默认 secret 已知时，IP/UA 加盐哈希可被反查，「IP 只存哈希」的隐私承诺会被削弱。
  if (isProductionLike(env) && env.QUOTE_SHARE_SECRET === DEV_QUOTE_SHARE_SECRET) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 QUOTE_SHARE_SECRET（≥32 字节随机值，例如 openssl rand -hex 32）；" +
        "否则报价链接与匿名 IP 哈希会使用公开的默认密钥。",
    );
  }
  // 与 secret 同一处、同一风格：只有真的会调用 LiteLLM 时才要求 key，local-rule 不阻断启动。
  // 请求期 provider 创建还有一层兜底（防止绕过 loadEnv 直接构造 provider）。
  if (
    isProductionLike(env) &&
    env.LLM_PROVIDER === "litellm" &&
    env.LITELLM_MASTER_KEY === DEV_LITELLM_MASTER_KEY
  ) {
    throw new Error(
      "生产/OIDC 模式使用 LLM_PROVIDER=litellm 时必须显式配置 LITELLM_MASTER_KEY；" +
        "否则会以公开的 dev 占位 key 连接模型网关。",
    );
  }
  return env;
}
