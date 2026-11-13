import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { PersonalAccessController } from "../auth/auth.controller";
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
import { AgentActorService } from "./agent-actor.service";
import { HumanActorService } from "./human-actor.service";
import { PublicQuoteController, QuoteSharesController } from "./shares.controllers";
import { PrintAgentController, PrintController } from "./print.controllers";
import { AGENT_ACTOR, HUMAN_ACTOR, KERNEL, PUBLIC_SHARE, QUOTE_AGENT, TOOLS } from "./tokens";

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
  AgentActorService,
  {
    provide: AGENT_ACTOR,
    useExisting: AgentActorService,
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
];

@Module({
  imports: [DatabaseModule, GatewayModule],
  controllers: [
    HealthController,
    PersonalAccessController,
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
