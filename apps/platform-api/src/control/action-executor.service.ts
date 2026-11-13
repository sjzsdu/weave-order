import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { JsonValue, PlatformRole } from "@weave-order/schema";
import { ChangeSubscriptionInput, InvoiceSettingsInput } from "@weave-order/schema";
import type { PlatformActor } from "../auth/auth.service";
import { invalid } from "../domain/errors";
import { BreakGlassService } from "./break-glass.service";
import { InvoicesService } from "./invoices.service";
import { PricingService } from "./pricing.service";
import { TenantsService } from "./tenants.service";
import { toJson } from "./util";

const ForcePlanPayload = z
  .object({
    tenantId: z.string().uuid(),
    input: ChangeSubscriptionInput,
    monthlyPriceCents: z.number().int().nonnegative(),
    reason: z.string().min(1),
  })
  .strict();

const PurgePayload = z.object({ tenantId: z.string().uuid(), reason: z.string().min(1) }).strict();
const PricePayload = z
  .object({ priceBookId: z.string().uuid(), reason: z.string().min(1) })
  .strict();
const TaxPayload = z.object({ settings: InvoiceSettingsInput, reason: z.string().min(1) }).strict();
const VoidPayload = z.object({ invoiceId: z.string().uuid(), reason: z.string().min(1) }).strict();
const RefundPayload = z
  .object({
    invoiceId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    reason: z.string().min(1),
  })
  .strict();
const BreakGlassPayload = z.object({ breakGlassId: z.string().uuid() }).strict();

export type ExecutableAction =
  | "TENANT_PURGE"
  | "TENANT_FORCE_PLAN"
  | "PRICE_CHANGE"
  | "TAX_CHANGE"
  | "INVOICE_VOID"
  | "REFUND"
  | "BREAK_GLASS";

/**
 * 双人复核通过后的唯一执行入口。
 * 每个动作都重新校验 payload（不信任审批表里的历史数据），并写平台审计。
 */
@Injectable()
export class ActionExecutorService {
  constructor(
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(BreakGlassService) private readonly breakGlass: BreakGlassService,
  ) {}

  async execute(
    actor: PlatformActor,
    action: ExecutableAction,
    payload: Record<string, JsonValue>,
  ): Promise<Record<string, JsonValue>> {
    switch (action) {
      case "TENANT_PURGE": {
        const parsed = PurgePayload.parse(payload);
        await this.tenants.purge(actor, parsed.tenantId, parsed.reason);
        return { purged: true, tenantId: parsed.tenantId };
      }
      case "TENANT_FORCE_PLAN": {
        const parsed = ForcePlanPayload.parse(payload);
        const tenant = await this.tenants.tenantOrThrow(parsed.tenantId);
        const plan = await this.tenants.planOrThrow(parsed.input.planCode);
        void plan;
        const overrideId = await this.pricing.createOverride(actor, {
          tenantId: parsed.tenantId,
          planCode: parsed.input.planCode,
          monthlyPriceCents: parsed.monthlyPriceCents,
          seats: parsed.input.seats,
          effectiveFrom: new Date(),
          effectiveTo: null,
          reason: parsed.reason,
        });
        const subscription = await this.tenants.applySubscription(actor, tenant.id, parsed.input, {
          overrideMonthlyPriceCents: parsed.monthlyPriceCents,
          overrideId,
          forceReason: parsed.reason,
        });
        return toJson({ overrideId, subscription }) as Record<string, JsonValue>;
      }
      case "PRICE_CHANGE": {
        const parsed = PricePayload.parse(payload);
        const book = await this.pricing.activateBook(actor, parsed.priceBookId, parsed.reason);
        return toJson({
          priceBookId: book.id,
          version: book.version,
          status: book.status,
        }) as Record<string, JsonValue>;
      }
      case "TAX_CHANGE": {
        const parsed = TaxPayload.parse(payload);
        const settings = await this.invoices.applySettings(actor, parsed.settings, parsed.reason);
        return toJson({ taxRateBp: settings.taxRateBp, version: settings.version }) as Record<
          string,
          JsonValue
        >;
      }
      case "INVOICE_VOID": {
        const parsed = VoidPayload.parse(payload);
        const invoice = await this.invoices.voidInvoice(actor, parsed.invoiceId, parsed.reason);
        return toJson({ invoiceId: invoice.id, status: invoice.status }) as Record<
          string,
          JsonValue
        >;
      }
      case "REFUND": {
        const parsed = RefundPayload.parse(payload);
        const refund = await this.invoices.applyRefund(
          actor,
          parsed.invoiceId,
          parsed.amountCents,
          parsed.reason,
        );
        return toJson({ refundId: refund.id, status: refund.status }) as Record<string, JsonValue>;
      }
      case "BREAK_GLASS": {
        const parsed = BreakGlassPayload.parse(payload);
        const request = await this.breakGlass.activate(actor, parsed.breakGlassId);
        return toJson({
          breakGlassId: request.id,
          status: request.status,
          expiresAt: request.expiresAt,
        }) as Record<string, JsonValue>;
      }
      default:
        throw invalid(`未知审批动作：${String(action)}`);
    }
  }

  requiredRoles(action: string): PlatformRole[] {
    const map: Record<string, PlatformRole[]> = {
      TENANT_PURGE: ["platform_owner"],
      TENANT_FORCE_PLAN: ["platform_owner"],
      PRICE_CHANGE: ["platform_owner", "platform_finance"],
      TAX_CHANGE: ["platform_owner", "platform_finance"],
      INVOICE_VOID: ["platform_finance"],
      REFUND: ["platform_owner", "platform_finance"],
      BREAK_GLASS: ["platform_owner"],
    };
    const roles = map[action];
    if (!roles) throw invalid(`未知审批动作：${action}`);
    return roles;
  }
}
