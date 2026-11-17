import {
  customerContexts,
  customers,
  decisionDeltas,
  orders,
  quotes,
  sampleShipmentItems,
  sampleShipments,
  samples,
} from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { CreateCustomerInput, CreateCustomerRequest, Customer360 } from "@weave-order/schema";
import type {
  Customer,
  CustomerContext,
  CustomerContextImport,
  CustomerListOptions,
  CustomerListItem,
  CustomerSummary,
  CustomerTimelineKind,
  CustomerTimelinePage,
  DecisionDelta,
  JsonValue,
  FabricSampleSummary,
  FollowupPreference,
  OrderSummary,
  PaymentPattern,
  PricingBehavior,
  QuoteSummary,
  T003GetCustomerHistoryData,
} from "@weave-order/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { loadCustomerList, loadCustomerSummary, loadCustomerTimeline } from "./customer-aggregates";
import { KernelError, isKernelError, isUniqueViolation } from "./errors";
import { memberDisplayName } from "./member-label";
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

/**
 * 客户编号前缀：`C` + 北京时间 `YYMMDD` + `-`。
 *
 * 用固定 +8 小时偏移而不是 `Intl`，避免运行环境时区/ICU 差异让同一天生成两个前缀。
 */
export function customerCodePrefix(now: Date = new Date()): string {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const yy = String(beijing.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(beijing.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(beijing.getUTCDate()).padStart(2, "0");
  return `C${yy}${mm}${dd}-`;
}

/** 前缀 + 至少 4 位序号（`C261116-0001`）；超过 9999 自然进位成 5 位。 */
export function formatCustomerCode(prefix: string, sequence: number): string {
  return `${prefix}${String(sequence).padStart(4, "0")}`;
}

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
   * 人类新建客户：`code` 可省略，由服务端按「同租户当日最大序号 + 1」生成。
   *
   * 序号查询与写入不在同一事务里，因此并发请求可能算出同一编号；唯一索引兜底，
   * 撞码时重算并重试（最多 3 次），仍失败就明确报错，绝不吞掉冲突。
   */
  async createForHuman(input: unknown, ctx: KernelContext): Promise<Customer> {
    const parsed = CreateCustomerRequest.parse(input);
    if (parsed.code) return this.create(parsed, ctx);

    const prefix = customerCodePrefix();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = formatCustomerCode(prefix, await this.nextCustomerSequence(prefix));
      try {
        return await this.create({ ...parsed, code }, ctx);
      } catch (error) {
        if (!isKernelError(error) || error.details.reason !== "CUSTOMER_CODE_EXISTS") throw error;
      }
    }
    throw new KernelError("KERNEL_REJECTED", "客户编号连续冲突，请稍后重试", {
      reason: "CUSTOMER_CODE_EXISTS",
    });
  }

  /** 同租户、同前缀（当日）的最大序号；非本格式的历史编号不参与计算。 */
  private async nextCustomerSequence(prefix: string): Promise<number> {
    const start = prefix.length + 1;
    const result = await this.db.execute<{ max_seq: number | string | null }>(sql`
      -- 显式 ::int：不带类型的参数会让 PostgreSQL 选到 regex 版 substring，
      -- 结果恒为 null，序号永远从 1 开始（并发时直接撞唯一索引）。
      SELECT MAX(substring(code from (${start})::int)::int) AS max_seq
      FROM customers
      WHERE tenant_id = ${this.tenantId}
        AND code LIKE ${`${prefix}%`}
        AND substring(code from (${start})::int) ~ '^[0-9]+$'
    `);
    const max = result.rows[0]?.max_seq;
    return (max === null || max === undefined ? 0 : Number(max)) + 1;
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

  /** T-003 get_customer_history 的内核实现。 */
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

    // 订单按确认时间倒序；未确认的草稿用创建时间兜底，否则 null 会排在最前。
    const orderRows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.customerId, customerId), eq(orders.tenantId, this.tenantId)))
      .orderBy(sql`coalesce(${orders.confirmedAt}, ${orders.createdAt}) desc`, desc(orders.id))
      .limit(limit);

    const recentOrders: OrderSummary[] = orderRows.map((row) => ({
      id: row.id,
      // 契约里草稿订单叫 PENDING，与 orders 表的 DRAFT 同义。
      status: row.status === "DRAFT" ? "PENDING" : row.status,
      currency: currencyOf(row.currency),
      total: { amount: row.totalAmount, currency: currencyOf(row.currency) },
      placedAt: toIso(row.confirmedAt ?? row.createdAt),
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
      recentOrders,
      recentSamples,
    };
  }

  /**
   * 客户 360 的数字面板：未决报价、在途寄样、应收余额、逾期、最近往来。
   * 一次聚合查询，口径与列表一致；不可见客户按「不存在」返回。
   */
  async customerSummary(customerId: string, ctx?: KernelContext): Promise<CustomerSummary> {
    return loadCustomerSummary(this.db, this.tenantId, customerId, ctx);
  }

  /** 客户 360 首屏：档案 + 上下文 + 汇总。 */
  async customer360(customerId: string, ctx?: KernelContext): Promise<Customer360> {
    const customer = await this.getById(customerId, ctx);
    // 顺序执行：生产路径下 `db` 是绑定 app.tenant_id 的单连接会话，
    // 同一 client 并发 query 会被 pg 拒绝/排队，不能让 RLS 会话里出现交错查询。
    const context = await this.getContext(customerId);
    const summary = await this.customerSummary(customerId, ctx);
    const ownerRows = await this.db.execute<{ owner_id: string | null; owner_name: string | null }>(
      sql`
        SELECT
          customers.owner_id,
          -- 负责人只取可展示的姓名/邮箱副本；subject 是 SSO 主键，不能当姓名返回（WAN-151）。
          COALESCE(
            NULLIF(BTRIM(memberships.display_name), ''),
            NULLIF(BTRIM(memberships.email), '')
          ) AS owner_name
        FROM customers
        LEFT JOIN memberships
          ON memberships.id = customers.owner_id
         AND memberships.tenant_id = customers.tenant_id
        WHERE customers.tenant_id = ${this.tenantId}
          AND customers.id = ${customerId}::uuid
        LIMIT 1
      `,
    );
    const owner = ownerRows.rows[0];
    const ownerId = owner?.owner_id ?? null;
    const ownerName = memberDisplayName(owner?.owner_name);
    return Customer360.parse({ customer, ownerId, ownerName, context, summary });
  }

  /** 客户时间线：五类源单据合并后按时间倒序，游标翻页。 */
  async customerTimeline(
    customerId: string,
    options: { kinds?: CustomerTimelineKind[]; limit?: number; cursor?: string | null } = {},
    ctx?: KernelContext,
  ): Promise<CustomerTimelinePage> {
    // 先判可见性：越权客户的时间线与档案一并按「不存在」返回，不泄露单据。
    await this.getById(customerId, ctx);
    return loadCustomerTimeline(this.db, this.tenantId, customerId, options);
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

  /**
   * 只读列表；按数据范围过滤，并附带四个聚合数字。
   * 接受数字（兼容旧调用）或筛选对象（客户列表页）。
   */
  async list(
    limitOrOptions: number | CustomerListOptions = 20,
    ctx?: KernelContext,
  ): Promise<CustomerListItem[]> {
    const options: CustomerListOptions =
      typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    return loadCustomerList(this.db, this.tenantId, options, ctx);
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
