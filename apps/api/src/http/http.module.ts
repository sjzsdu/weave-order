import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { Provider } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";
import { PublicShareService } from "../shares/public-share.service";
import { PrintAgentAuthService } from "../print/agent-auth.service";
import { PrintAgentHub } from "../print/agent-hub";
import { AppDatabaseProvider, DatabaseProvider } from "../platform/database.provider";
import { DatabaseModule } from "../platform/database.module";
import { createTools } from "../tools";
import { QuoteAgentService } from "./quote-agent.service";
import type { Tools } from "../tools";
import {
  ApprovalController,
  AuditController,
  CatalogController,
  HealthController,
  ImportController,
  OrderController,
  PanoramaController,
  PricingController,
  QuoteController,
  RevisionController,
  QuoteAgentController,
} from "./controllers";
import { HumanActorService } from "./human-actor.service";
import { PublicQuoteController, QuoteSharesController } from "./shares.controllers";
import { PrintAgentController, PrintController } from "./print.controllers";
import { HUMAN_ACTOR, KERNEL, PUBLIC_SHARE, QUOTE_AGENT, TOOLS } from "./tokens";

const providers: Provider[] = [
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
  HumanActorService,
  {
    provide: HUMAN_ACTOR,
    useExisting: HumanActorService,
  },
  QuoteAgentService,
  PrintAgentAuthService,
  PrintAgentHub,
  {
    provide: QUOTE_AGENT,
    useFactory: (service: QuoteAgentService): QuoteAgentService => service,
    inject: [QuoteAgentService],
  },
  {
    provide: PUBLIC_SHARE,
    useFactory: (database: AppDatabaseProvider): PublicShareService =>
      new PublicShareService(database.pool),
    inject: [AppDatabaseProvider],
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
  imports: [DatabaseModule, GatewayModule],
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
    PricingController,
    OrderController,
    RevisionController,
    QuoteAgentController,
    PublicQuoteController,
    QuoteSharesController,
    PrintController,
    PrintAgentController,
  ],
  providers,
})
export class HttpModule {}
