import { Injectable } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { connectDatabase } from "./database";
import type { DatabaseHandle } from "./database";
import { loadEnv } from "./env";

/**
 * 平台/控制面连接：迁移、开通租户、membership 映射。
 * 不用于业务数据请求。
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
 */
@Injectable()
export class AppDatabaseProvider implements OnApplicationShutdown {
  readonly pool: Pool;

  constructor() {
    const env = loadEnv();
    this.pool = new Pool({
      connectionString: env.APP_DATABASE_URL ?? env.DATABASE_URL,
      max: 20,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
