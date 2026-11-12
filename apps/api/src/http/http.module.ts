import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";
import { DatabaseProvider } from "../platform/database.provider";
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
import { HUMAN_ACTOR, KERNEL, QUOTE_AGENT, TOOLS } from "./tokens";

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
  {
    provide: QUOTE_AGENT,
    useFactory: (service: QuoteAgentService): QuoteAgentService => service,
    inject: [QuoteAgentService],
  },
];

@Module({
  imports: [DatabaseModule, GatewayModule],
  controllers: [
    HealthController,
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
  ],
  providers,
})
export class HttpModule {}
