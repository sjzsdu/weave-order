import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { createPlatformDb } from "@weave-order/control-db";
import type { PlatformDb, PlatformDbHandle } from "@weave-order/control-db";
import { loadEnv } from "../env";

export const PLATFORM_DATABASE = Symbol("PLATFORM_DATABASE");

/** 控制面唯一连接句柄。只有 service 层持有，控制器不碰数据库。 */
@Injectable()
export class PlatformDatabaseProvider implements OnApplicationShutdown {
  readonly handle: PlatformDbHandle;

  constructor() {
    this.handle = createPlatformDb(loadEnv().PLATFORM_DATABASE_URL);
  }

  get db(): PlatformDb {
    return this.handle.db;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.pool.end();
  }
}

export type { PlatformDb };

export const databaseProvider = {
  provide: PLATFORM_DATABASE,
  useFactory: (provider: PlatformDatabaseProvider): PlatformDb => provider.db,
  inject: [PlatformDatabaseProvider],
};

export { Inject };
