import { z } from "zod";
import { isProductionLike } from "./runtime-mode";

/** 仅本地/测试使用的占位密钥；生产出现即 fail-fast（与 database-guard 同一策略）。 */
export const DEV_QUOTE_SHARE_SECRET = "dev-only-quote-share-secret-change-me-0001";
/** 打印代理 token 的本地占位密钥；生产必须覆盖。 */
export const DEV_PRINT_AGENT_SECRET = "dev-only-print-agent-secret-change-me-0001";
/** 个人访问凭据（PAT）哈希的本地占位密钥；生产必须覆盖。 */
export const DEV_PERSONAL_TOKEN_PEPPER = "dev-only-personal-token-pepper-change-me-0001";
/** 开通链接（onboarding ticket）的本地占位密钥；生产必须覆盖，且与平台侧一致。 */
export const DEV_ONBOARDING_SECRET = "dev-only-onboarding-secret-change-me-0001";

/** 仅本地/测试使用的 LiteLLM 占位 key；生产 + litellm provider 时拒绝启动。 */
export const DEV_LITELLM_MASTER_KEY = "sk-local-dev";

/**
 * 本地 MinIO 的占位凭据（docker-compose.yml 同值）；生产出现即拒绝启动。
 * 对象存储里放的是客户面料图，公开默认凭据等于把整桶图片交出去。
 */
export const DEV_S3_ACCESS_KEY_ID = "weave-media";
export const DEV_S3_SECRET_ACCESS_KEY = "weave-media-secret";

/** 环境变量里的布尔值：只认 1/true/yes/on，"false" 不会被当成 true。 */
function booleanEnv(fallback: boolean) {
  return z
    .preprocess((value) => {
      if (value === undefined || value === "") return fallback;
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") {
        return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
      }
      return fallback;
    }, z.boolean())
    .default(fallback);
}

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
  /**
   * 租户会话存储：auto（dev 用进程内，其余用 Redis）/ redis / memory。
   * 多实例部署必须用 redis，否则同一个人会被不同实例随机判为未登录。
   */
  SESSION_STORE: z.enum(["auto", "redis", "memory"]).default("auto"),
  /** 会话 TTL（秒，滑动续期）；默认 7 天。 */
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  CASDOOR_ISSUER: z.string().url().default("https://sso.wnbgj.com"),
  CASDOOR_AUDIENCE: z.string().min(1).default("weave-order"),
  CASDOOR_JWKS_URI: z.string().url().optional(),
  /** 客户报价分享链接的站点根地址。 */
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5174"),
  /** 客户报价链接的 HMAC 密钥；生产必须覆盖为 ≥32 字节随机值。 */
  QUOTE_SHARE_SECRET: z.string().min(32).default(DEV_QUOTE_SHARE_SECRET),
  /** 平台控制面签发的开通链接密钥；必须与 apps/platform-api 的 ONBOARDING_SECRET 相同。 */
  ONBOARDING_SECRET: z.string().min(32).default(DEV_ONBOARDING_SECRET),
  /** T-001 imageUrl 变体允许取图的对象存储 / CDN 域名（逗号分隔）。 */
  MEDIA_ALLOWED_HOSTS: z.string().default(""),
  /** 单张图片上限（上传与按 URL 取图共用；默认 10MB）。 */
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(10_485_760).default(10_485_760),
  // ---- 对象存储（S3 兼容：本地 MinIO / 生产腾讯云 COS）----
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1).default("weave-media"),
  S3_ACCESS_KEY_ID: z.string().min(1).default(DEV_S3_ACCESS_KEY_ID),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default(DEV_S3_SECRET_ACCESS_KEY),
  /** MinIO 只支持 path-style；COS 必须关。 */
  S3_FORCE_PATH_STYLE: booleanEnv(true),
  /** 公开读域名（CDN）；缺省回落到 `S3_ENDPOINT/<bucket>`，本地即 MinIO 公开读地址。 */
  MEDIA_BASE_URL: z.string().url().optional(),
  /** 上传预签名有效期（秒）。 */
  MEDIA_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().max(604_800).default(600),
  /** 打印代理 token 的 HS256 密钥；生产必须覆盖为 ≥32 字节随机值。 */
  PRINT_AGENT_SECRET: z.string().min(32).default(DEV_PRINT_AGENT_SECRET),
  /** 服务端 A4 PDF 的中文字体（TTF/OTF；TTC 不受支持）。 */
  PRINT_CJK_FONT_PATH: z.string().optional(),
  /** 可选：headless Chromium 路径，用于 HTML→PDF 精确渲染；缺省走内置版式。 */
  PRINT_CHROME_PATH: z.string().optional(),
  /** 个人访问凭据（CLI / agent）哈希的 pepper；生产必须覆盖为 ≥32 字节随机值。 */
  PERSONAL_TOKEN_PEPPER: z.string().min(16).default(DEV_PERSONAL_TOKEN_PEPPER),
  /** CLI 登录确认页所在的租户端 Web 地址（与 API 分开部署）。 */
  WEB_APP_URL: z.string().url().default("http://localhost:3001"),
  /** 控制面地址：自助开通的公司要登记试用订阅。缺省时不登记（本地/单机模式）。 */
  PLATFORM_API_URL: z.string().url().optional(),
  /** 出站通知：log（默认，只记日志不发送）或 webhook（交给自建网关调邮件/短信服务商）。 */
  NOTIFY_PROVIDER: z.enum(["log", "webhook"]).default("log"),
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),
  NOTIFY_TOKEN: z.string().optional(),
  /** 新公司默认每月 credits（1 credit = 1,000 tokens）；套餐升级时由平台调整。 */
  DEFAULT_MONTHLY_CREDITS: z.coerce.number().int().positive().default(20000),
  /** CLI 设备登录确认码有效期与轮询间隔（秒）。 */
  DEVICE_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  DEVICE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
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
  if (isProductionLike(env) && env.PERSONAL_TOKEN_PEPPER === DEV_PERSONAL_TOKEN_PEPPER) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 PERSONAL_TOKEN_PEPPER（≥16 字节随机值，例如 openssl rand -hex 32）；" +
        "否则 PAT 的哈希 pepper 是公开默认值。",
    );
  }
  if (isProductionLike(env) && env.PRINT_AGENT_SECRET === DEV_PRINT_AGENT_SECRET) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 PRINT_AGENT_SECRET（≥32 字节随机值），否则任何人都能伪造打印代理 token。",
    );
  }
  if (isProductionLike(env) && env.ONBOARDING_SECRET === DEV_ONBOARDING_SECRET) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 ONBOARDING_SECRET（≥32 字节随机值），否则任何人都能伪造开通链接、自建公司空间。",
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
  // 图片链路不允许「悄悄退回 base64 / 本地磁盘」：没有对象存储凭据就拒绝启动。
  if (
    isProductionLike(env) &&
    (env.S3_ACCESS_KEY_ID === DEV_S3_ACCESS_KEY_ID ||
      env.S3_SECRET_ACCESS_KEY === DEV_S3_SECRET_ACCESS_KEY)
  ) {
    throw new Error(
      "生产/OIDC 模式必须显式配置 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY（对象存储凭证）；" +
        "否则图片会以公开的 dev 凭据写入桶。",
    );
  }
  return env;
}
