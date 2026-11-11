import {
  customerContexts,
  customers,
  quotes,
  sampleShipmentItems,
  sampleShipments,
  samples,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateCustomerInput } from "@weave-order/schema";
import type {
  Customer,
  CustomerContext,
  DecisionDelta,
  FabricSampleSummary,
  FollowupPreference,
  PaymentPattern,
  PricingBehavior,
  QuoteSummary,
  T003GetCustomerHistoryData,
} from "@weave-order/schema";
import { desc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";
import { currencyOf, toIso } from "./mappers";

const DEFAULT_PRICING_BEHAVIOR: PricingBehavior = {
  sensitivity: "MEDIUM",
  counterofferAcceptanceRate: null,
  typicalAcceptanceWindowDays: null,
  notes: [],
};

const DEFAULT_PAYMENT_PATTERN: PaymentPattern = {
  preferredTerms: null,
  onTimeRate: null,
  averageDelayDays: null,
  notes: [],
};

const DEFAULT_FOLLOWUP_PREFERENCE: FollowupPreference = {
  preferredChannel: null,
  preferredTimeWindow: null,
  avoidDays: [],
  notes: [],
};

type CustomerRow = typeof customers.$inferSelect;
type ContextRow = typeof customerContexts.$inferSelect;

function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    tier: row.tier,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
  };
}

function mapContext(row: ContextRow): CustomerContext {
  return {
    customerId: row.customerId,
    preferenceNotes: row.preferenceNotes,
    pricingBehavior: row.pricingBehavior,
    paymentPattern: row.paymentPattern,
    followupPreference: row.followupPreference,
    decisionDeltas: row.decisionDeltas,
    updatedAt: toIso(row.updatedAt),
  };
}

/**
 * 客户内核服务。
 * 唯一写入 customers / customer_contexts 的入口，每次写入都带同事务审计。
 */
export class CustomerService {
  constructor(private readonly db: Db) {}

  async create(input: unknown, ctx: KernelContext): Promise<Customer> {
    const parsed = CreateCustomerInput.parse(input);
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(customers)
          .values({
            code: parsed.code,
            name: parsed.name,
            tier: parsed.tier,
            contactName: parsed.contactName ?? null,
            contactPhone: parsed.contactPhone ?? null,
            contactEmail: parsed.contactEmail ?? null,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new KernelError("KERNEL_REJECTED", "客户写入未返回记录", {
            reason: "INSERT_RETURNED_NO_ROW",
          });
        }
        await tx.insert(customerContexts).values({
          customerId: row.id,
          preferenceNotes: [],
          pricingBehavior: DEFAULT_PRICING_BEHAVIOR,
          paymentPattern: DEFAULT_PAYMENT_PATTERN,
          followupPreference: DEFAULT_FOLLOWUP_PREFERENCE,
          decisionDeltas: [] as DecisionDelta[],
        });
        await appendAudit(tx, ctx, {
          action: "CUSTOMER_CREATED",
          entityType: "customer",
          entityId: row.id,
          before: null,
          after: { code: row.code, name: row.name, tier: row.tier },
        });
        return mapCustomer(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError("KERNEL_REJECTED", `客户编号已存在：${parsed.code}`, {
          reason: "CUSTOMER_CODE_EXISTS",
        });
      }
      throw error;
    }
  }

  async getById(customerId: string): Promise<Customer> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, {
        customerId,
      });
    }
    return mapCustomer(row);
  }

  /** T-003 get_customer_history 的内核实现。订单表尚未建立，recentOrders 为空。 */
  async getHistory(customerId: string, limit: number): Promise<T003GetCustomerHistoryData> {
    const customer = await this.getById(customerId);

    const contextRows = await this.db
      .select()
      .from(customerContexts)
      .where(eq(customerContexts.customerId, customerId))
      .limit(1);
    const contextRow = contextRows[0];
    if (!contextRow) {
      throw new KernelError("KERNEL_REJECTED", `客户上下文缺失：${customerId}`, {
        reason: "CUSTOMER_CONTEXT_MISSING",
      });
    }

    const quoteRows = await this.db
      .select()
      .from(quotes)
      .where(eq(quotes.customerId, customerId))
      .orderBy(desc(quotes.createdAt))
      .limit(limit);

    const recentQuotes: QuoteSummary[] = quoteRows.map((row) => ({
      id: row.id,
      status: row.status,
      currency: currencyOf(row.currency),
      total: { amount: row.totalAmount, currency: currencyOf(row.currency) },
      createdAt: toIso(row.createdAt),
    }));

    const sampleRows = await this.db
      .select({ sample: samples })
      .from(sampleShipmentItems)
      .innerJoin(sampleShipments, eq(sampleShipmentItems.shipmentId, sampleShipments.id))
      .innerJoin(samples, eq(sampleShipmentItems.sampleId, samples.id))
      .where(eq(sampleShipments.customerId, customerId))
      .orderBy(desc(samples.createdAt))
      .limit(limit);

    const recentSamples: FabricSampleSummary[] = sampleRows.map(({ sample }) => ({
      id: sample.id,
      code: sample.code,
      name: sample.name,
      composition: sample.composition,
      weight: sample.weight,
    }));

    return {
      customer,
      context: mapContext(contextRow),
      recentQuotes,
      recentOrders: [],
      recentSamples,
    };
  }

  /** 记录人类修改智能体建议的决策增量（护城河核心数据）。 */
  async appendDecisionDelta(
    customerId: string,
    delta: DecisionDelta,
    ctx: KernelContext,
  ): Promise<CustomerContext> {
    const current = await this.getContext(customerId);
    const nextDeltas = [...current.decisionDeltas, delta];
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(customerContexts)
        .set({ decisionDeltas: nextDeltas, updatedAt: new Date() })
        .where(eq(customerContexts.customerId, customerId))
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, {
          customerId,
        });
      }
      await appendAudit(tx, ctx, {
        action: "CUSTOMER_CONTEXT_UPDATED",
        entityType: "customer_context",
        entityId: customerId,
        before: { decisionDeltaCount: current.decisionDeltas.length },
        after: { decisionDeltaCount: nextDeltas.length, field: delta.field },
      });
      return mapContext(row);
    });
  }

  async getContext(customerId: string): Promise<CustomerContext> {
    const rows = await this.db
      .select()
      .from(customerContexts)
      .where(eq(customerContexts.customerId, customerId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, {
        customerId,
      });
    }
    return mapContext(row);
  }
}
