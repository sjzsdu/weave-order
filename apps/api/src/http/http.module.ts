import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";
import { DatabaseProvider } from "../platform/database.provider";
import { DatabaseModule } from "../platform/database.module";
import { createTools } from "../tools";
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
} from "./controllers";
import { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL, TOOLS } from "./tokens";

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
  ],
  providers,
})
export class HttpModule {}
