import { Global, Module } from "@nestjs/common";
import { PlatformDatabaseProvider, databaseProvider } from "./database.provider";

@Global()
@Module({
  providers: [PlatformDatabaseProvider, databaseProvider],
  exports: [PlatformDatabaseProvider, databaseProvider],
})
export class DatabaseModule {}
