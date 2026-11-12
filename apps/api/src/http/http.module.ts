import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { Provider } from "@nestjs/common";
import { createApprovalService } from "../approval";
import type { ApprovalService } from "../approval";
import { AuthController, CliLoginPageController } from "../auth/auth.controller";
import { AuthGuard } from "../auth/auth.guard";
import { AuthService } from "../auth/auth.service";
import { AuthErrorFilter } from "../auth/errors";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";
import { createTools } from "../tools";
import type { Tools } from "../tools";
import {
  ApprovalController,
  AuditController,
  CatalogController,
  HealthController,
  ImportController,
  PanoramaController,
  QuoteController,
} from "./controllers";
import { DatabaseProvider } from "./database.provider";
import { APPROVAL, KERNEL, TOOLS } from "./tokens";

const providers: Provider[] = [
  DatabaseProvider,
  {
    provide: KERNEL,
    useFactory: (database: DatabaseProvider): Kernel => createKernel(database.handle.db),
    inject: [DatabaseProvider],
  },
  {
    provide: TOOLS,
    useFactory: (kernel: Kernel): Tools => createTools(kernel),
    inject: [KERNEL],
  },
  {
    provide: APPROVAL,
    useFactory: (kernel: Kernel): ApprovalService => createApprovalService(kernel),
    inject: [KERNEL],
  },
  {
    provide: AuthService,
    useFactory: (kernel: Kernel): AuthService => new AuthService(kernel),
    inject: [KERNEL],
  },
  // 全局凭据守卫：任何路由都可声明 @RequireScope，未声明则只校验凭据有效性。
  { provide: APP_GUARD, useClass: AuthGuard },
  // 守卫抛出的 AuthError 与控制器一致，统一映射成 { error: { code, message } }。
  { provide: APP_FILTER, useClass: AuthErrorFilter },
];

@Module({
  controllers: [
    HealthController,
    AuthController,
    CliLoginPageController,
    CatalogController,
    QuoteController,
    AuditController,
    ApprovalController,
    PanoramaController,
    ImportController,
  ],
  providers,
})
export class HttpModule {}
