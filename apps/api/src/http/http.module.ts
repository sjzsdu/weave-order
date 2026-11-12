import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { createApprovalService } from "../approval";
import type { ApprovalService } from "../approval";
import { createQuoteExportService } from "../export";
import type { QuoteExportService } from "../export";
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
import { QuoteExportController } from "./export.controller";
import { APPROVAL, KERNEL, QUOTE_EXPORT, TOOLS } from "./tokens";

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
    provide: QUOTE_EXPORT,
    useFactory: (kernel: Kernel): QuoteExportService => createQuoteExportService(kernel),
    inject: [KERNEL],
  },
];

@Module({
  controllers: [
    HealthController,
    CatalogController,
    QuoteController,
    AuditController,
    ApprovalController,
    PanoramaController,
    ImportController,
    QuoteExportController,
  ],
  providers,
})
export class HttpModule {}
