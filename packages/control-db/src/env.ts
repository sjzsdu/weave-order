export const DEFAULT_PLATFORM_DATABASE_URL = "postgres://weave:weave@localhost:5433/weave_platform";

export function resolvePlatformDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV === "production" && !env.PLATFORM_DATABASE_URL) {
    throw new Error("生产环境必须显式配置 PLATFORM_DATABASE_URL（控制面独立库）");
  }
  return env.PLATFORM_DATABASE_URL ?? DEFAULT_PLATFORM_DATABASE_URL;
}
