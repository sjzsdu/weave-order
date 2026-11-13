import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { PlatformAuthGuard } from "./auth/auth.guard";
import { DatabaseModule } from "./db/database.module";
import { ControlModule } from "./control/control.module";

@Module({
  imports: [DatabaseModule, AuthModule, ControlModule],
  providers: [{ provide: APP_GUARD, useClass: PlatformAuthGuard }],
})
export class AppModule {}
