/** 本地默认与 docker-compose.yml 对齐；全部可用环境变量覆盖。 */
export const DEFAULT_DATABASE_URL = "postgres://weave:weave@localhost:5433/weave_order";
export const DEFAULT_REDIS_URL = "redis://localhost:6380";

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}
