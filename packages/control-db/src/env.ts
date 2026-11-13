export const DEFAULT_PLATFORM_DATABASE_URL = "postgres://weave:weave@localhost:5433/weave_platform";

export function resolvePlatformDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLATFORM_DATABASE_URL ?? DEFAULT_PLATFORM_DATABASE_URL;
}
