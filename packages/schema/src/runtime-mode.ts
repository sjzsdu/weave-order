/**
 * 运行时「生产态」判定 —— api 与 web 的唯一事实源。
 *
 * 生产态 = `NODE_ENV=production` **或** `AUTH_MODE=oidc`。
 * OIDC 意味着已接入真实身份源（哪怕是 staging），此时任何 dev 占位值都不允许静默生效。
 *
 * 所有 fail-fast 门控（数据库角色、分享密钥、审批角色、缺失令牌、Secure Cookie、
 * 开发登录入口）都走这个函数，避免每个模块各写一份 OR 条件，漏掉
 * `NODE_ENV=development + AUTH_MODE=oidc` 的组合。放在 schema 包里是因为
 * api（CommonJS dist）与 web（Next bundler）都能消费同一份实现，且它零依赖。
 *
 * 纯函数：不读全局、不缓存，调用方传入环境对象（默认 process.env），测试可直接构造。
 */
export interface RuntimeModeInput {
  NODE_ENV?: string;
  AUTH_MODE?: string;
  /** 部署形态标记：`dev` / `test` / `production`。与 `NODE_ENV` 分开，见下。 */
  WEAVE_ENV?: string;
}

export function isProductionLike(env: RuntimeModeInput = process.env): boolean {
  return env.NODE_ENV === "production" || env.AUTH_MODE === "oidc";
}

/**
 * 「这是一个可重置的测试环境」判定。
 *
 * 为什么不用 `NODE_ENV=test`：测试环境的硬要求是与生产同构
 * （`NODE_ENV=production + AUTH_MODE=oidc`），`NODE_ENV=test` 只属于单元测试进程。
 * 所以需要第四个部署维度 `WEAVE_ENV`，由部署侧显式注入：
 *
 * - 本地 dev：不设或 `WEAVE_ENV=dev`
 * - 测试环境：`WEAVE_ENV=test`（必须同时是生产态，否则配置错误）
 * - 生产环境：不设或 `WEAVE_ENV=production`
 *
 * 只有显式 `test` 才为真。任何拼错的/缺失的值都按生产处理，这是安全默认。
 */
export function isTestEnv(env: RuntimeModeInput = process.env): boolean {
  return env.WEAVE_ENV === "test";
}

/**
 * `demo:reset` 的唯一准入判定。
 *
 * 允许：本地 dev（非生产态）与显式标记的测试环境（生产态 + WEAVE_ENV=test）。
 * 拒绝：生产态且未标记 test —— 生产库永远不能被一键清空。
 * 错误由调用方抛出（脚本 / 启动门控共用同一个布尔判定）。
 */
export function canResetDemoData(env: RuntimeModeInput = process.env): boolean {
  return !isProductionLike(env) || isTestEnv(env);
}

/**
 * `demo:reset` 的第二道门。
 *
 * 测试环境是「生产态 + WEAVE_ENV=test」，与生产只差一个环境变量。一旦 `.env.test`
 * 被拷到生产机器上，`WEAVE_ENV=test` 这一个值就同时放行 `/api/demo/*` 和「一键清库」。
 * 所以生产态下的重置必须再显式确认一次（`DEMO_RESET_CONFIRM=1`），本地 dev 不需要。
 *
 * 判定与 `canResetDemoData` 分开：后者是 api 启动门控（测试环境要能启动），
 * 这里只约束「清库」这个动作。
 */
export function needsDemoResetConfirmation(
  env: RuntimeModeInput & { DEMO_RESET_CONFIRM?: string } = process.env,
): boolean {
  return isProductionLike(env) && isTestEnv(env) && env.DEMO_RESET_CONFIRM !== "1";
}
