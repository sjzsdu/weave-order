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
import { OnboardingController, TeamController } from "../onboarding/onboarding.controller";
import { CreditsController } from "./usage.controller";
import { OnboardingService } from "../onboarding/onboarding.service";
import { PublicRateLimitService } from "../platform/rate-limit";
import { MediaService } from "../media/media.service";
import { createObjectStorageFromEnv } from "../platform/storage";
import { loadEnv } from "../platform/env";
import { QuoteAgentService } from "./quote-agent.service";
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
import { MediaController } from "./media.controllers";
import { SampleController } from "./samples.controllers";
import {
  AGENT_ACTOR,
  HUMAN_ACTOR,
  KERNEL,
  MEDIA_SERVICE,
  PUBLIC_RATE_LIMIT,
  PUBLIC_SHARE,
  QUOTE_AGENT,
} from "./tokens";

const providers: Provider[] = [
  {
    // 回落内核：仅供本地/演示的无凭据路径与 /api/health 探针使用。
    // 真实租户的每一条请求（HUMAN 与 AGENT 两条面）都由各自的 actor service
    // 通过 `openScope` 打开绑定 tenantId 的会话内核，见 human-actor.service.ts
    // 与 agent-actor.service.ts（铁律 G4）。
    provide: KERNEL,
    useFactory: (database: DatabaseProvider): Kernel => createKernel(database.handle.db),
    inject: [DatabaseProvider],
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
    // 显式工厂：限流器的构造参数是配置（secret / redisUrl），不走 Nest 反射注入。
    provide: PUBLIC_RATE_LIMIT,
    useFactory: (): PublicRateLimitService => new PublicRateLimitService(),
  },
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
  OnboardingService,
  {
    // 对象存储句柄只在组合根创建；控制器与内核都拿不到它。
    provide: MEDIA_SERVICE,
    useFactory: (): MediaService => new MediaService(createObjectStorageFromEnv(loadEnv())),
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
    MediaController,
    SampleController,
    OnboardingController,
    TeamController,
    CreditsController,
  ],
  providers,
})
export class HttpModule {}
