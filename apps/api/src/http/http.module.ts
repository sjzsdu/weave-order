import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { createKernel } from "../kernel";
import type { Kernel } from "../kernel";
import { createTools } from "../tools";
import type { Tools } from "../tools";
import {
  AuditController,
  CatalogController,
  HealthController,
  QuoteController,
} from "./controllers";
import { DatabaseProvider } from "./database.provider";
import { KERNEL, TOOLS } from "./tokens";

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
];

@Module({
  controllers: [HealthController, CatalogController, QuoteController, AuditController],
  providers,
})
export class HttpModule {}
