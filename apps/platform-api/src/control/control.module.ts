import { Module } from "@nestjs/common";
import { ActionExecutorService } from "./action-executor.service";
import { ApprovalsService } from "./approvals.service";
import { AuditService } from "./audit.service";
import { BreakGlassService } from "./break-glass.service";
import { InvoicesService } from "./invoices.service";
import { OverviewService } from "./overview.service";
import { PricingService } from "./pricing.service";
import { SettingsService } from "./settings.service";
import { SupportService } from "./support.service";
import { TenantsService } from "./tenants.service";
import { TrialSweepService } from "./trial-sweep.service";
import { UsageService } from "./usage.service";
import {
  HealthController,
  InvoicesController,
  MaintenanceController,
  InvoiceSettingsController,
  OverviewController,
  TenantsController,
} from "../http/controllers";
import { InternalController } from "../http/internal.controller";
import {
  ApprovalsController,
  AuditController,
  BreakGlassController,
  ConfigsController,
  FeatureFlagsController,
  IdentityController,
  LlmSettingsController,
  PricingController,
  SupportController,
  UsageController,
} from "../http/settings.controllers";

const services = [
  AuditService,
  TenantsService,
  TrialSweepService,
  PricingService,
  InvoicesService,
  UsageService,
  BreakGlassService,
  ActionExecutorService,
  ApprovalsService,
  SettingsService,
  SupportService,
  OverviewService,
];

const controllers = [
  HealthController,
  InternalController,
  OverviewController,
  TenantsController,
  MaintenanceController,
  InvoicesController,
  InvoiceSettingsController,
  UsageController,
  PricingController,
  LlmSettingsController,
  FeatureFlagsController,
  ConfigsController,
  IdentityController,
  ApprovalsController,
  AuditController,
  BreakGlassController,
  SupportController,
];

@Module({
  providers: services,
  controllers,
  exports: services,
})
export class ControlModule {}
