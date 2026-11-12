import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { createApprovalService } from "../approval";
import type { ApprovalService } from "../approval";
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
  MasterDataController,
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
];

@Module({
  controllers: [
    HealthController,
    CatalogController,
    MasterDataController,
    QuoteController,
    AuditController,
    ApprovalController,
    PanoramaController,
    ImportController,
  ],
  providers,
})
export class HttpModule {}
