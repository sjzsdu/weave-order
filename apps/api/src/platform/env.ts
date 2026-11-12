import { z } from "zod";

/**
 * 运行时环境变量契约。
 * 默认值与 docker-compose.yml 一致，因此本地 `docker compose up` 后
 * 不需要 .env 也能跑通；线上用环境变量覆盖。
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://weave:weave@localhost:5433/weave_order"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6380"),
  /** embedding provider：local-stub（默认，无需外部 key） */
  EMBEDDING_PROVIDER: z.string().min(1).default("local-stub"),
  /** 智能体 LLM provider：local-rule（默认，确定性规则，无需 key） */
  LLM_PROVIDER: z.string().min(1).default("local-rule"),
  /** 物流 provider：local-deterministic（默认，本地确定性） */
  LOGISTICS_PROVIDER: z.string().min(1).default("local-deterministic"),
  /** 客户回复来源：local-scripted（默认，便于演示与测试） */
  REPLY_SOURCE: z.string().min(1).default("local-scripted"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** 对外 URL：CLI 设备登录的确认页链接基于它拼接。 */
  PUBLIC_API_URL: z.string().url().default("http://localhost:3000"),
  /** token 哈希的额外密钥；生产环境必须覆盖，否则库被读也无法离线穷举。 */
  AUTH_TOKEN_PEPPER: z.string().min(8).default("weave-order-dev-pepper"),
  /** 是否强制要求凭据；生产环境无论该值如何都强制。 */
  AUTH_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** CLI 设备登录授权有效期（秒）。 */
  DEVICE_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  /** CLI 轮询最小间隔（秒）。 */
  DEVICE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
