import type { Env } from "./env";
import { isProductionLike } from "./runtime-mode";

/**
 * 业务连接池的启动期守卫。
 *
 * 背景：`DATABASE_URL` 在本地/默认部署里是 superuser（docker-compose 的 weave），
 * 会静默绕过 RLS。生产若忘配 `APP_DATABASE_URL`，越权不会被任何错误暴露。
 * 因此：
 * - 生产 / OIDC 模式必须显式提供 `APP_DATABASE_URL`；
 * - 只要显式提供了业务 URL，启动时就断言连接角色不是 SUPERUSER / BYPASSRLS。
 */
export interface AppDatabaseResolution {
  url: string;
  /** 显式配置了业务 URL 时必须做角色断言；dev 回退到 owner 时不检查。 */
  requiresRoleCheck: boolean;
  /** dev 回退到 owner 连接，明确告警（仅本地/CI 允许）。 */
  fellBackToOwner: boolean;
}

export function resolveAppDatabaseUrl(
  env: Pick<Env, "APP_DATABASE_URL" | "DATABASE_URL" | "NODE_ENV" | "AUTH_MODE">,
): AppDatabaseResolution {
  const strict = isProductionLike(env);
  if (!env.APP_DATABASE_URL) {
    if (strict) {
      throw new Error(
        "生产/OIDC 模式必须显式配置 APP_DATABASE_URL，且角色必须是 weave_app（NOSUPERUSER / NOBYPASSRLS）；" +
          "否则业务连接会以 owner 身份绕过 RLS。",
      );
    }
    return { url: env.DATABASE_URL, requiresRoleCheck: false, fellBackToOwner: true };
  }
  return { url: env.APP_DATABASE_URL, requiresRoleCheck: true, fellBackToOwner: false };
}

export interface RolePrivileges {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/**
 * 断言业务连接角色没有绕过 RLS 的能力。
 * 不满足即抛出，让进程启动失败，而不是带着越权风险静默运行。
 */
export function assertNonBypassRole(role: RolePrivileges): void {
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `业务连接角色 ${role.rolname} 拥有 SUPERUSER 或 BYPASSRLS，会绕过 RLS；` +
        "请把 APP_DATABASE_URL 指向 weave_app（NOSUPERUSER / NOBYPASSRLS）。",
    );
  }
}
