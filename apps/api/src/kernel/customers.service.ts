import {
  customerContexts,
  customers,
  decisionDeltas,
  quotes,
  sampleShipmentItems,
  sampleShipments,
  samples,
} from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { CreateCustomerInput } from "@weave-order/schema";
import type {
  Customer,
  CustomerContext,
  CustomerContextImport,
  DecisionDelta,
  JsonValue,
  FabricSampleSummary,
  FollowupPreference,
  PaymentPattern,
  PricingBehavior,
  QuoteSummary,
  T003GetCustomerHistoryData,
} from "@weave-order/schema";
import { and, desc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";
import { ownerScopeFilter } from "./data-scope";
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
    tenantId: row.tenantId,
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
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async create(input: unknown, ctx: KernelContext): Promise<Customer> {
    const parsed = CreateCustomerInput.parse(input);
    try {
      return await this.db.transaction((tx) => this.insertWithin(tx, parsed, ctx));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError("KERNEL_REJECTED", `客户编号已存在：${parsed.code}`, {
          reason: "CUSTOMER_CODE_EXISTS",
        });
      }
      throw error;
    }
  }

  /**
   * 在外部事务内插入客户 + 私有上下文 + 同事务审计，不自行开事务。
   * 单条 create 与批量导入共用这一处写逻辑，避免两套落库路径漂移；
   * `context` 为导入时可选的私有上下文（缺省字段用内核默认值补齐）。
   */
  async insertWithin(
    tx: Tx,
    parsed: CreateCustomerInput,
    ctx: KernelContext,
    context?: CustomerContextImport,
  ): Promise<Customer> {
    const rows = await tx
      .insert(customers)
      .values({
        tenantId: this.tenantId,
        // 人类创建即归属创建人（OWN 范围据此可见）；系统/智能体创建不设归属人。
        ownerId: ctx.ownerId ?? null,
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
      tenantId: this.tenantId,
      preferenceNotes: context?.preferenceNotes ?? [],
      pricingBehavior: context?.pricingBehavior ?? DEFAULT_PRICING_BEHAVIOR,
      paymentPattern: context?.paymentPattern ?? DEFAULT_PAYMENT_PATTERN,
      followupPreference: context?.followupPreference ?? DEFAULT_FOLLOWUP_PREFERENCE,
      decisionDeltas: [] as DecisionDelta[],
    });
    await appendAudit(
      tx,
      ctx,
      {
        action: "CUSTOMER_CREATED",
        entityType: "customer",
        entityId: row.id,
        before: null,
        after: { code: row.code, name: row.name, tier: row.tier },
      },
      this.tenantId,
    );
    return mapCustomer(row);
  }

  /** 单条读取；`ctx` 带数据范围时越权一律按「不存在」处理。 */
  async getById(customerId: string, ctx?: KernelContext): Promise<Customer> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.tenantId, this.tenantId),
          ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
        ),
      )
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
  async getHistory(
    customerId: string,
    limit: number,
    ctx?: KernelContext,
  ): Promise<T003GetCustomerHistoryData> {
    // `ctx` 带数据范围时，越权客户的档案与历史一并按「不存在」返回。
    const customer = await this.getById(customerId, ctx);

    const contextRows = await this.db
      .select()
      .from(customerContexts)
      .where(
        and(
          eq(customerContexts.customerId, customerId),
          eq(customerContexts.tenantId, this.tenantId),
        ),
      )
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
      .where(and(eq(quotes.customerId, customerId), eq(quotes.tenantId, this.tenantId)))
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
      .where(
        and(
          eq(sampleShipments.customerId, customerId),
          eq(sampleShipments.tenantId, this.tenantId),
        ),
      )
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
        .where(
          and(
            eq(customerContexts.customerId, customerId),
            eq(customerContexts.tenantId, this.tenantId),
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, {
          customerId,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "CUSTOMER_CONTEXT_UPDATED",
          entityType: "customer_context",
          entityId: customerId,
          before: { decisionDeltaCount: current.decisionDeltas.length },
          after: { decisionDeltaCount: nextDeltas.length, field: delta.field },
        },
        this.tenantId,
      );
      return mapContext(row);
    });
  }

  /** 只读列表，给页面选择演示客户用；按数据范围过滤。 */
  async list(limit = 20, ctx?: KernelContext): Promise<Customer[]> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, this.tenantId),
          ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
        ),
      )
      .orderBy(desc(customers.createdAt))
      .limit(limit);
    return rows.map(mapCustomer);
  }

  async getContext(customerId: string): Promise<CustomerContext> {
    const rows = await this.db
      .select()
      .from(customerContexts)
      .where(
        and(
          eq(customerContexts.customerId, customerId),
          eq(customerContexts.tenantId, this.tenantId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, {
        customerId,
      });
    }
    return mapContext(row);
  }

  /** 决策增量历史（可聚合的训练信号）：改价 / 驳回谁改了哪个字段。 */
  async listDecisionDeltas(
    customerId: string,
    limit = 50,
    ctx?: KernelContext,
  ): Promise<
    Array<{
      id: string;
      entityType: string;
      entityId: string;
      field: string;
      originalValue: JsonValue | null;
      modifiedValue: JsonValue | null;
      scenarioTag: string;
      actorType: string;
      actorId: string;
      reasonId: string | null;
      note: string | null;
      createdAt: string;
    }>
  > {
    await this.getById(customerId, ctx);
    const rows = await this.db
      .select()
      .from(decisionDeltas)
      .where(
        and(eq(decisionDeltas.tenantId, this.tenantId), eq(decisionDeltas.customerId, customerId)),
      )
      .orderBy(desc(decisionDeltas.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      field: row.field,
      originalValue: row.originalValue ?? null,
      modifiedValue: row.modifiedValue ?? null,
      scenarioTag: row.scenarioTag,
      actorType: row.actorType,
      actorId: row.actorId,
      reasonId: row.reasonId,
      note: row.note,
      createdAt: toIso(row.createdAt),
    }));
  }
}
