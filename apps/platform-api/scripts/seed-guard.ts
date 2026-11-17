/**
 * 控制面 seed 的入口硬闸门。
 *
 * 演示平台人员（owner@weaveorder.cn 等 6 个）和演示租户（qinghe / huarui）
 * 绝不允许落进生产控制面库。此前 seed.ts 直接用 `resolvePlatformDatabaseUrl()`
 * 建连，绕过了 `loadEnv()` 的生产校验，导致生产环境仍可手工跑 seed。
 *
 * 口径与 apps/api/scripts/demo-reset.ts 一致：
 * - 生产态（NODE_ENV=production 或 PLATFORM_AUTH_MODE=oidc）默认拒绝；
 * - 测试环境必须显式 `WEAVE_ENV=test` 才放行；
 * - 本地 development + dev 模式放行。
 *
 * 独立成文件是为了让 seed-guard.test.ts 能直接单测，不必跑真实 seed。
 */

export class SeedForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedForbiddenError";
  }
}

/** 与 platform-api 生产判定一致：OIDC 或 NODE_ENV=production 即视为生产态。 */
export function isSeedProductionLike(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.PLATFORM_AUTH_MODE === "oidc";
}

/** 测试环境必须显式声明，才允许在生产态形态下跑 seed（CI 同构测试用）。 */
export function isExplicitTestEnv(env: NodeJS.ProcessEnv): boolean {
  return env.WEAVE_ENV === "test";
}

/**
 * 生产态 seed 拒绝执行；返回 void，违规时抛 SeedForbiddenError。
 */
export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (!isSeedProductionLike(env) || isExplicitTestEnv(env)) return;
  throw new SeedForbiddenError(
    "拒绝在生产环境执行 platform:seed：演示平台人员与演示租户不允许写入生产控制面库。" +
      "若确为测试环境，请显式设置 WEAVE_ENV=test；本地请用 NODE_ENV=development + PLATFORM_AUTH_MODE=dev。",
  );
}
