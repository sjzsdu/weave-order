import {
  BadRequestException,
  Inject,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ChangeSubscriptionInput,
  InvoiceSettingsInput,
  RefundInput,
  TenantStatusInput,
} from "@weave-order/schema";
import type { PlatformActor, PlatformRequest } from "../auth/auth.service";
import { Public, RequirePermission } from "../auth/decorators";
import { invalid } from "../domain/errors";
import { ApprovalsService } from "../control/approvals.service";
import { InvoicesService } from "../control/invoices.service";
import { OverviewService } from "../control/overview.service";
import { PricingService } from "../control/pricing.service";
import { TenantsService } from "../control/tenants.service";
import { UsageService } from "../control/usage.service";

function actorOf(request: PlatformRequest): PlatformActor {
  if (!request.platformActor) throw new Error("guard 未注入平台身份");
  return request.platformActor;
}

@Controller("platform/api")
export class HealthController {
  @Get("health")
  @Public()
  health() {
    return { ok: true, service: "weave-platform-control-plane", isolation: "control-only" };
  }
}

@Controller("platform/api")
export class OverviewController {
  constructor(
    @Inject(OverviewService) private readonly overview: OverviewService,
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  @Get("overview")
  @RequirePermission("overview:read")
  get() {
    return this.overview.get();
  }

  @Get("usage/overview")
  @RequirePermission("usage:read")
  usageOverview() {
    return this.usage.overview();
  }
}

@Controller("platform/api/tenants")
export class TenantsController {
  constructor(
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @RequirePermission("tenant:read")
  async list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("plan") plan?: string,
  ) {
    return {
      tenants: await this.tenants.list({
        q,
        status: status as never,
        planCode: plan,
      }),
    };
  }

  @Post()
  @RequirePermission("tenant:write")
  async provision(@Req() request: PlatformRequest, @Body() body: unknown) {
    return { tenant: await this.tenants.provision(actorOf(request), body) };
  }

  @Get(":id")
  @RequirePermission("tenant:read")
  get(@Param("id") id: string) {
    return this.tenants.get(id);
  }

  /**
   * 普通改套餐/席位直接生效；强制定价（forceMonthlyPriceCents）走双人复核，
   * 返回 approval 而不是订阅，避免「一个人就能给客户改价」。
   */
  @Patch(":id/subscription")
  @RequirePermission("tenant:write")
  async changeSubscription(
    @Req() request: PlatformRequest,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = actorOf(request);
    const input = ChangeSubscriptionInput.parse(body);
    if (body.forceMonthlyPriceCents !== undefined) {
      const monthly = Number(body.forceMonthlyPriceCents);
      if (!Number.isInteger(monthly) || monthly < 0) throw invalid("强制定价必须是非负整数分");
      const reason =
        typeof body.forceReason === "string"
          ? body.forceReason
          : typeof body.reason === "string"
            ? body.reason
            : "合同价调整";
      const approval = await this.approvals.create(actor, {
        action: "TENANT_FORCE_PLAN",
        targetType: "tenant",
        targetId: id,
        summary: `强制改套餐与合同价（${monthly / 100} 元/席位/月）`,
        payload: {
          tenantId: id,
          input: {
            planCode: input.planCode,
            seats: input.seats,
            billingCycle: input.billingCycle,
            reason,
          },
          monthlyPriceCents: monthly,
          reason,
        },
        reason,
      });
      return { approval, applied: false };
    }
    return { subscription: await this.tenants.applySubscription(actor, id, input), applied: true };
  }

  @Post(":id/status")
  @RequirePermission("tenant:status")
  async setStatus(@Req() request: PlatformRequest, @Param("id") id: string, @Body() body: unknown) {
    TenantStatusInput.parse(body);
    return { tenant: await this.tenants.setStatus(actorOf(request), id, body) };
  }

  /** 注销 / 清数据：永远只创建双人复核申请，不直接执行。 */
  @Post(":id/purge-request")
  @RequirePermission("tenant:purge")
  async purgeRequest(
    @Req() request: PlatformRequest,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    const tenant = await this.tenants.tenantOrThrow(id);
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestException("注销必须填写原因");
    const approval = await this.approvals.create(actorOf(request), {
      action: "TENANT_PURGE",
      targetType: "tenant",
      targetId: id,
      summary: `注销租户「${tenant.name}」（仅注销控制面账号，账单与审计合规保留）`,
      payload: { tenantId: id, reason },
      reason,
    });
    return { approval };
  }

  @Get(":id/usage")
  @RequirePermission("usage:read")
  async tenantUsage(@Param("id") id: string) {
    return {
      ...(await this.usage.month(id)),
      events: await this.usage.recentEvents(id, 20),
    };
  }

  @Get(":id/tax-profile")
  @RequirePermission("billing:read")
  profile(@Param("id") id: string) {
    return this.invoices.getTaxProfile(id);
  }

  @Put(":id/tax-profile")
  @RequirePermission("billing:write")
  async updateProfile(
    @Req() request: PlatformRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.invoices.upsertTaxProfile(actorOf(request), { ...(body as object), tenantId: id });
  }

  @Get(":id/overrides")
  @RequirePermission("pricing:read")
  async overrides(@Param("id") id: string) {
    return { overrides: await this.pricing.listOverrides(id) };
  }
}

@Controller("platform/api/invoices")
export class InvoicesController {
  constructor(
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @RequirePermission("billing:read")
  async list(@Query("tenantId") tenantId?: string, @Query("status") status?: string) {
    return { invoices: await this.invoices.list({ tenantId, status: status as never }) };
  }

  @Post()
  @RequirePermission("billing:write")
  async create(@Req() request: PlatformRequest, @Body() body: unknown) {
    return { invoice: await this.invoices.create(actorOf(request), body) };
  }

  @Get(":id")
  @RequirePermission("billing:read")
  get(@Param("id") id: string) {
    return this.invoices.get(id);
  }

  @Post(":id/issue")
  @RequirePermission("invoice:issue")
  async issue(@Req() request: PlatformRequest, @Param("id") id: string, @Body() body: unknown) {
    return { invoice: await this.invoices.issue(actorOf(request), id, body ?? {}) };
  }

  @Post(":id/paid")
  @RequirePermission("billing:write")
  async paid(@Req() request: PlatformRequest, @Param("id") id: string, @Body() body: unknown) {
    return { invoice: await this.invoices.markPaid(actorOf(request), id, body ?? {}) };
  }

  @Get(":id/refunds")
  @RequirePermission("billing:read")
  async refunds(@Param("id") id: string) {
    return { refunds: await this.invoices.listRefunds(id) };
  }

  /** 退款是资金出账：owner + finance 双人复核，批准后才写入退款记录。 */
  @Post(":id/refund-request")
  @RequirePermission("invoice:refund")
  async refundRequest(
    @Req() request: PlatformRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = RefundInput.parse(body);
    const invoice = await this.invoices.get(id);
    const approval = await this.approvals.create(actorOf(request), {
      action: "REFUND",
      targetType: "invoice",
      targetId: id,
      summary: `退款发票 ${invoice.number}（¥${(input.amountCents / 100).toLocaleString()}）`,
      payload: { invoiceId: id, amountCents: input.amountCents, reason: input.reason },
      reason: input.reason,
    });
    return { approval };
  }

  /** 红冲：改金额必须财务复核，所以只创建审批申请。 */
  @Post(":id/void-request")
  @RequirePermission("invoice:void")
  async voidRequest(
    @Req() request: PlatformRequest,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    const invoice = await this.invoices.get(id);
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestException("红冲必须填写原因");
    const approval = await this.approvals.create(actorOf(request), {
      action: "INVOICE_VOID",
      targetType: "invoice",
      targetId: id,
      summary: `红冲发票 ${invoice.number}（${invoice.totalCents / 100} 元）`,
      payload: { invoiceId: id, reason },
      reason,
    });
    return { approval };
  }
}

@Controller("platform/api/settings/invoicing")
export class InvoiceSettingsController {
  constructor(
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @RequirePermission("settings:read")
  get() {
    return this.invoices.getSettings();
  }

  /** 税率变更需 owner + finance 双人复核；其他字段可直接改。 */
  @Patch()
  @RequirePermission("settings:write")
  async update(@Req() request: PlatformRequest, @Body() body: unknown) {
    const actor = actorOf(request);
    const input = InvoiceSettingsInput.parse(body);
    const current = await this.invoices.getSettings();
    if (input.taxRateBp !== undefined && input.taxRateBp !== current.taxRateBp) {
      const reason = input.reason ?? "调整开票税率";
      const approval = await this.approvals.create(actor, {
        action: "TAX_CHANGE",
        targetType: "invoice_settings",
        targetId: "default",
        summary: `开票税率 ${current.taxRateBp / 100}% → ${input.taxRateBp / 100}%`,
        payload: { settings: input, reason },
        reason,
      });
      return { approval, applied: false };
    }
    return { settings: await this.invoices.applySettings(actor, input), applied: true };
  }
}
