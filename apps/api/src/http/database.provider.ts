import { Injectable } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { connectDatabase } from "../platform/database";
import type { DatabaseHandle } from "../platform/database";
import { loadEnv } from "../platform/env";

/**
 * 应用级数据库连接。
 *
 * 只有 platform / kernel 能拿到它；HTTP 控制器通过 kernel / tools 间接访问，
 * agent 层连 import 都不允许（ESLint 边界）。
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
