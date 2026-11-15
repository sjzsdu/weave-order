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
}

export function isProductionLike(env: RuntimeModeInput = process.env): boolean {
  return env.NODE_ENV === "production" || env.AUTH_MODE === "oidc";
}
