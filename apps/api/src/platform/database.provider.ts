import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { connectDatabase } from "./database";
import type { DatabaseHandle } from "./database";
import { assertNonBypassRole, resolveAppDatabaseUrl } from "./database-guard";
import { loadEnv } from "./env";

/**
 * 平台/控制面连接。
 *
 * 硬约束（不得破坏）：这条连接用于迁移、开通租户、membership 目录查询，
 * **永远不能用于业务数据请求**。它拥有跨租户可见性（owner / BYPASSRLS），
 * 一旦被业务代码复用，RLS 就形同虚设。业务请求只能通过 AppDatabaseProvider
 * 打开租户会话。
 */
@Injectable()
export class DatabaseProvider implements OnApplicationShutdown {
  readonly handle: DatabaseHandle;

  constructor() {
    this.handle = connectDatabase(loadEnv().DATABASE_URL);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.pool.end();
  }
}

/**
 * 业务连接池：生产必须指向 weave_app（NOSUPERUSER / NOBYPASSRLS）。
 * 网关为每个请求从这里借一条连接并 SET app.tenant_id。
 *
 * 启动守卫（fail-fast）：
 * - 生产 / OIDC 模式缺 APP_DATABASE_URL 直接拒绝启动；
 * - 显式配置了业务 URL 时，查询 pg_roles 断言当前角色无 SUPERUSER / BYPASSRLS。
 */
@Injectable()
export class AppDatabaseProvider implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AppDatabaseProvider.name);
  readonly pool: Pool;
  private readonly requiresRoleCheck: boolean;

  constructor() {
    const resolution = resolveAppDatabaseUrl(loadEnv());
    if (resolution.fellBackToOwner) {
      this.logger.warn(
        "未配置 APP_DATABASE_URL，业务连接回退到 DATABASE_URL（owner）。" +
          "这仅允许本地开发；生产/OIDC 模式会拒绝启动。",
      );
    }
    this.requiresRoleCheck = resolution.requiresRoleCheck;
    this.pool = new Pool({ connectionString: resolution.url, max: 20 });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.requiresRoleCheck) return;
    const result = await this.pool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    const role = result.rows[0];
    if (!role) {
      throw new Error("无法确认业务连接角色，拒绝启动");
    }
    assertNonBypassRole(role);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
