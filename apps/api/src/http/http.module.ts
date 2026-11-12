import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { createApprovalService } from "../approval";
import type { ApprovalService } from "../approval";
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
  PanoramaController,
  QuoteController,
} from "./controllers";
import { APPROVAL, KERNEL, TOOLS } from "./tokens";

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
  {
    provide: APPROVAL,
    useFactory: (kernel: Kernel): ApprovalService => createApprovalService(kernel),
    inject: [KERNEL],
  },
];

@Module({
  imports: [DatabaseModule],
  controllers: [
    HealthController,
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
