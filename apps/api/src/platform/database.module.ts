import { Global, Module } from "@nestjs/common";
import { AppDatabaseProvider, DatabaseProvider } from "./database.provider";
import { SchemaReadinessProbe } from "./schema-readiness";

/** 组合根的最小单元：连接池只在这里创建，其余模块通过 DI 拿到句柄。 */
@Global()
@Module({
  providers: [DatabaseProvider, AppDatabaseProvider, SchemaReadinessProbe],
  exports: [DatabaseProvider, AppDatabaseProvider, SchemaReadinessProbe],
})
export class DatabaseModule {}
