import {
  auditLog,
  customerContacts,
  customerContexts,
  customers,
  decisionDeltas,
  inboundMessages,
  items,
  orders,
  quotes,
  receivables,
  sampleShipmentItems,
  sampleShipments,
  samples,
} from "@weave-order/db";
import type { CustomerContactRow, Db, Tx } from "@weave-order/db";
import {
  CreateCustomerDraftInput,
  CreateCustomerInput,
  CreateCustomerRequest,
  Customer360,
  CustomerDraftResponse,
  CustomerMergePreview,
  CustomerMergeResult,
  CustomerMergeUndoResult,
  hasCapability,
  maskEmail,
  maskPhone,
  normalizePhone,
  MergeCustomerInput,
  UndoCustomerMergeInput,
  weightMeasurementFrom,
} from "@weave-order/schema";
import type { MemberRole } from "@weave-order/schema";
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
  DraftFieldInput,
  JsonValue,
  FabricSampleSummary,
  FollowupPreference,
  OrderSummary,
  PaymentPattern,
  PricingBehavior,
  QuoteSummary,
  T003GetCustomerHistoryData,
} from "@weave-order/schema";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { loadActiveContacts, loadPrimaryContactRow } from "./contact-read";
import { loadCustomerList, loadCustomerSummary, loadCustomerTimeline } from "./customer-aggregates";
import { CodeNumberService } from "./code-number.service";
import { KernelError, isUniqueViolation } from "./errors";
import type { FieldOptionsService } from "./field-options.service";
import { memberDisplayName } from "./member-label";
import { ownerScopeFilter } from "./data-scope";
import { currencyOf, toIso } from "./mappers";
import { createMergeToken, verifyMergeToken } from "./merge-token";
import type { ResourceFieldService } from "./resource-fields.service";

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

/**
 * 档案读模型：联系人三列一律取 `customer_contacts` 的主联系人投影，
 * 不再读 `customers.contact_*`（那三列只做兼容投影，由写路径双写）。
 * 没有联系人时回退 NULL，页面显示「未登记联系人」。
 */
function mapCustomer(
  row: CustomerRow,
  primary?: CustomerContactRow | null,
  role?: MemberRole,
): Customer {
  // 与 `contact-read.toContact` 同一条规则：只有缺 `contact.pii.view` 的角色（VIEWER）掩码。
  const masked = role !== undefined && !hasCapability(role, "contact.pii.view");
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    tier: row.tier,
    status: row.status,
    contactName: primary?.name ?? null,
    contactPhone: masked ? maskPhone(primary?.phone) : (primary?.phone ?? null),
    contactEmail: masked ? maskEmail(primary?.email) : (primary?.email ?? null),
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
  /** 编号生成服务；未注入时按自身 db/tenantId 构造（兼容老单测的直接 new）。 */
  private readonly codeNumber: CodeNumberService;

  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    /**
     * 等级写入闸门。`tier` 列在 P0 从 enum 放宽成 varchar 后，这里必须解析到已有选项，
     * 否则导入/API/智能体都能写下悬挂 code（历史客户会显示成原始字符串）。
     */
    private readonly fieldOptions?: FieldOptionsService,
    /** 字段出处矩阵；草稿 / 逐字段确认 / 合并预览共用。 */
    private readonly resourceFields?: ResourceFieldService,
    /** 合并票据签名密钥（预览与撤销窗口共用）。 */
    private readonly mergeSecret: string = "weave-order-local-merge-secret",
    codeNumber?: CodeNumberService,
  ) {
    this.codeNumber = codeNumber ?? new CodeNumberService(db, tenantId);
  }

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
   * 人类新建客户：`code` 可省略，由服务端按编号规则生成。
   *
   * 取号与写入同一事务、原子计数器递增（见 CodeNumberService.allocateAndWrite），
   * 唯一索引只作兜底且只有命中客户编号索引才重算。显式 code 优先，规则不介入。
   */
  async createForHuman(input: unknown, ctx: KernelContext): Promise<Customer> {
    const parsed = CreateCustomerRequest.parse(input);
    if (parsed.code) return this.create(parsed, ctx);
    return this.db.transaction((tx) =>
      this.codeNumber.allocateAndWrite(tx, "customer", new Date(), (code) =>
        this.insertWithin(tx, { ...parsed, code }, ctx),
      ),
    );
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
    // 人类表单给 code，智能体/CSV 可能给 label；统一解析成稳定 code 再落库。
    const tier = this.fieldOptions
      ? await this.fieldOptions.resolveTierCode(parsed.tier, ctx)
      : parsed.tier;
    const hasContact = Boolean(parsed.contactName || parsed.contactPhone || parsed.contactEmail);
    // 投影必须与即将写入的联系人行逐字一致：只有手机/邮箱时联系人名落「主要联系人」。
    const projectedContactName = hasContact ? (parsed.contactName ?? "主要联系人") : null;
    const rows = await tx
      .insert(customers)
      .values({
        tenantId: this.tenantId,
        // 人类创建即归属创建人（OWN 范围据此可见）；系统/智能体创建不设归属人。
        ownerId: ctx.ownerId ?? null,
        code: parsed.code,
        name: parsed.name,
        tier,
        // 旧三列是主联系人投影；联系人行仍是唯一事实源（下面同事务写入）。
        contactName: projectedContactName,
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
    let primaryContact: CustomerContactRow | null = null;
    if (hasContact) {
      const contactRows = await tx
        .insert(customerContacts)
        .values({
          tenantId: this.tenantId,
          customerId: row.id,
          name: projectedContactName ?? "主要联系人",
          phone: parsed.contactPhone ?? null,
          phoneNormalized: normalizePhone(parsed.contactPhone),
          email: parsed.contactEmail ?? null,
          isPrimary: true,
        })
        .returning();
      primaryContact = contactRows[0] ?? null;
      if (primaryContact) {
        await appendAudit(
          tx,
          ctx,
          {
            action: "CONTACT_CREATED",
            entityType: "customer_contact",
            entityId: primaryContact.id,
            before: null,
            after: {
              customerId: row.id,
              name: primaryContact.name,
              role: primaryContact.role,
              isPrimary: true,
            },
            entityLabel: primaryContact.name,
          },
          this.tenantId,
        );
      }
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
    return mapCustomer(row, primaryContact, ctx.actor.role);
  }

  /**
   * 从名片/文本建客户草稿（`sourceId` 幂等）。
   *
   * 草稿允许缺名称等非关键字段：主表先落占位值，字段矩阵里保持 PENDING，
   * 确认页据此显示「待补充」。草稿不参与去重建议与历史价取数。
   */
  async createDraft(input: unknown, ctx: KernelContext): Promise<CustomerDraftResponse> {
    const parsed = CreateCustomerDraftInput.parse(input);
    const existing = await this.findByDraftSource(parsed.sourceId);
    if (existing) {
      return this.draftResponse(existing, false);
    }

    try {
      const customer = await this.db.transaction((tx) =>
        this.codeNumber.allocateAndWrite(tx, "customer", new Date(), async (code) => {
          const rows = await tx
            .insert(customers)
            .values({
              tenantId: this.tenantId,
              ownerId: ctx.ownerId ?? null,
              code,
              name: parsed.name ?? "待确认客户",
              tier: parsed.tier ?? "REGULAR",
              status: "DRAFT",
              draftSourceId: parsed.sourceId,
              contactName: parsed.contactName ?? null,
              contactPhone: parsed.contactPhone ?? null,
              contactEmail: parsed.contactEmail ?? null,
            })
            .returning();
          const row = rows[0];
          if (!row) {
            throw new KernelError("KERNEL_REJECTED", "客户草稿写入未返回记录", {
              reason: "INSERT_RETURNED_NO_ROW",
            });
          }
          if (parsed.contactName || parsed.contactPhone || parsed.contactEmail) {
            await tx.insert(customerContacts).values({
              tenantId: this.tenantId,
              customerId: row.id,
              name: parsed.contactName ?? "主要联系人",
              phone: parsed.contactPhone ?? null,
              phoneNormalized: normalizePhone(parsed.contactPhone),
              email: parsed.contactEmail ?? null,
              isPrimary: true,
            });
          }
          await tx.insert(customerContexts).values({
            customerId: row.id,
            tenantId: this.tenantId,
            preferenceNotes: [],
            pricingBehavior: DEFAULT_PRICING_BEHAVIOR,
            paymentPattern: DEFAULT_PAYMENT_PATTERN,
            followupPreference: DEFAULT_FOLLOWUP_PREFERENCE,
            decisionDeltas: [] as DecisionDelta[],
          });

          const fields = this.draftFieldInputs(parsed, "bizcard");
          await this.resourceFields?.writeDraftFields(tx, "customer", row.id, fields);
          if (!fields.some((field) => field.fieldName === "name")) {
            await this.resourceFields?.markPending(tx, "customer", row.id, "name");
          }
          await appendAudit(
            tx,
            ctx,
            {
              action: "CUSTOMER_DRAFT_CREATED",
              entityType: "customer",
              entityId: row.id,
              before: null,
              after: { sourceId: parsed.sourceId, fieldCount: fields.length },
              entityLabel: row.name,
            },
            this.tenantId,
          );
          return row;
        }),
      );
      return this.draftResponse(customer, true);
    } catch (error) {
      // 草稿幂等键（sourceId）冲突不是撞码：allocateAndWrite 会原样冒泡，
      // 这里命中既有草稿就返回 created=false，与改造前语义一致。
      const duplicateSource = await this.findByDraftSource(parsed.sourceId);
      if (duplicateSource) return this.draftResponse(duplicateSource, false);
      throw error;
    }
  }

  private draftFieldInputs(
    parsed: ReturnType<typeof CreateCustomerDraftInput.parse>,
    sourceKind: DraftFieldInput["sourceKind"],
  ): DraftFieldInput[] {
    const fields: DraftFieldInput[] = [];
    const topLevel: Array<[string, string | null | undefined]> = [
      ["name", parsed.name],
      ["tier", parsed.tier],
      ["contactName", parsed.contactName],
      ["contactPhone", parsed.contactPhone],
      ["contactEmail", parsed.contactEmail],
    ];
    for (const [fieldName, value] of topLevel) {
      if (value === undefined || value === null || value === "") continue;
      fields.push({ fieldName, value, sourceKind, sourceId: parsed.sourceId });
    }
    for (const field of parsed.fields ?? []) fields.push(field);
    return fields;
  }

  private async findByDraftSource(sourceId: string): Promise<CustomerRow | null> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, this.tenantId), eq(customers.draftSourceId, sourceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async draftResponse(row: CustomerRow, created: boolean): Promise<CustomerDraftResponse> {
    const primary = await loadPrimaryContactRow(this.db, this.tenantId, row.id);
    const fields = this.resourceFields
      ? await this.resourceFields.list("customer", row.id, row.status)
      : [];
    return CustomerDraftResponse.parse({
      customer: mapCustomer(row, primary),
      created,
      fields,
    });
  }

  /** 草稿 → 可用。幂等：已可用直接返回；必填字段未确认则拒绝并列出字段。 */
  async confirmDraft(customerId: string, ctx: KernelContext): Promise<Customer> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, this.tenantId)))
      .limit(1);
    const before = rows[0];
    if (!before) {
      throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, { customerId });
    }
    if (before.status === "AVAILABLE") {
      const primary = await loadPrimaryContactRow(this.db, this.tenantId, customerId);
      return mapCustomer(before, primary, ctx.actor.role);
    }
    if (before.status !== "DRAFT") {
      throw new KernelError("KERNEL_REJECTED", "只有草稿客户可以确认可用", {
        reason: "CUSTOMER_NOT_DRAFT",
      });
    }
    await this.resourceFields?.assertRequiredConfirmed("customer", customerId, ["name"]);

    const updated = await this.db.transaction(async (tx) => {
      const next = await tx
        .update(customers)
        .set({ status: "AVAILABLE", updatedAt: new Date() })
        .where(and(eq(customers.id, customerId), eq(customers.tenantId, this.tenantId)))
        .returning();
      const row = next[0];
      if (!row) {
        throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, { customerId });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "CUSTOMER_CONFIRMED",
          entityType: "customer",
          entityId: customerId,
          before: { status: "DRAFT" },
          after: { status: "AVAILABLE" },
          entityLabel: row.name,
        },
        this.tenantId,
      );
      return row;
    });
    const primary = await loadPrimaryContactRow(this.db, this.tenantId, customerId);
    return mapCustomer(updated, primary, ctx.actor.role);
  }

  /**
   * 合并影响预览。
   *
   * 只读，不做任何写入；返回签名票据把「用户看到的这份预览」绑定到下一次确认。
   */
  async previewMerge(
    sourceCustomerId: string,
    targetCustomerId: string,
    ctx: KernelContext,
  ): Promise<CustomerMergePreview> {
    this.assertCanMerge(ctx);
    if (sourceCustomerId === targetCustomerId) {
      throw new KernelError("KERNEL_REJECTED", "不能把客户合并到自己", {
        reason: "MERGE_SELF",
      });
    }
    const source = await this.requireCustomerRow(sourceCustomerId);
    const target = await this.requireCustomerRow(targetCustomerId);
    if (source.status === "ARCHIVED") {
      throw new KernelError("KERNEL_REJECTED", "已归档客户不能再合并", {
        reason: "MERGE_SOURCE_ARCHIVED",
      });
    }
    if (target.status !== "AVAILABLE") {
      throw new KernelError("KERNEL_REJECTED", "只能合并到可用客户", {
        reason: "MERGE_TARGET_NOT_AVAILABLE",
      });
    }

    const counts = await this.mergeCounts(sourceCustomerId);
    const contactConflicts = await this.mergeContactConflicts(sourceCustomerId, targetCustomerId);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    return CustomerMergePreview.parse({
      sourceCustomerId,
      targetCustomerId,
      counts,
      contactConflicts,
      previewToken: createMergeToken(this.mergeSecret, {
        purpose: "preview",
        tenantId: this.tenantId,
        sourceCustomerId,
        targetCustomerId,
        exp: expiresAt.getTime(),
      }),
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * 执行合并：把源客户的单据与联系人迁到目标客户，源客户归档。
   *
   * 联系人遇到目标客户已有的手机/邮箱时**不迁**（留在源客户下，随归档保留），
   * 因为数据库的部分唯一索引不允许同客户重复联系方式；预览已提前展示这一影响。
   */
  async merge(
    sourceCustomerId: string,
    input: unknown,
    ctx: KernelContext,
  ): Promise<CustomerMergeResult> {
    this.assertCanMerge(ctx);
    const parsed = MergeCustomerInput.parse(input);
    const payload = this.verifyToken(parsed.previewToken, "preview");
    if (
      payload.sourceCustomerId !== sourceCustomerId ||
      payload.targetCustomerId !== parsed.targetCustomerId
    ) {
      throw new KernelError("KERNEL_REJECTED", "合并预览与本次目标不一致，请重新预览", {
        reason: "MERGE_PREVIEW_MISMATCH",
      });
    }
    const source = await this.requireCustomerRow(sourceCustomerId);
    const target = await this.requireCustomerRow(parsed.targetCustomerId);
    if (source.status === "ARCHIVED") {
      throw new KernelError("KERNEL_REJECTED", "已归档客户不能再合并", {
        reason: "MERGE_SOURCE_ARCHIVED",
      });
    }
    if (target.status !== "AVAILABLE") {
      throw new KernelError("KERNEL_REJECTED", "只能合并到可用客户", {
        reason: "MERGE_TARGET_NOT_AVAILABLE",
      });
    }

    const moved = await this.db.transaction(async (tx) => {
      const ids = {
        quotes: (
          await tx
            .select({ id: quotes.id })
            .from(quotes)
            .where(and(eq(quotes.tenantId, this.tenantId), eq(quotes.customerId, sourceCustomerId)))
        ).map((row) => row.id),
        orders: (
          await tx
            .select({ id: orders.id })
            .from(orders)
            .where(and(eq(orders.tenantId, this.tenantId), eq(orders.customerId, sourceCustomerId)))
        ).map((row) => row.id),
        sampleShipments: (
          await tx
            .select({ id: sampleShipments.id })
            .from(sampleShipments)
            .where(
              and(
                eq(sampleShipments.tenantId, this.tenantId),
                eq(sampleShipments.customerId, sourceCustomerId),
              ),
            )
        ).map((row) => row.id),
        receivables: (
          await tx
            .select({ id: receivables.id })
            .from(receivables)
            .where(
              and(
                eq(receivables.tenantId, this.tenantId),
                eq(receivables.customerId, sourceCustomerId),
              ),
            )
        ).map((row) => row.id),
        items: (
          await tx
            .select({ id: items.id })
            .from(items)
            .where(and(eq(items.tenantId, this.tenantId), eq(items.customerId, sourceCustomerId)))
        ).map((row) => row.id),
        decisionDeltas: (
          await tx
            .select({ id: decisionDeltas.id })
            .from(decisionDeltas)
            .where(
              and(
                eq(decisionDeltas.tenantId, this.tenantId),
                eq(decisionDeltas.customerId, sourceCustomerId),
              ),
            )
        ).map((row) => row.id),
      };
      if (ids.quotes.length > 0) {
        await tx
          .update(quotes)
          .set({ customerId: target.id })
          .where(inArray(quotes.id, ids.quotes));
      }
      if (ids.orders.length > 0) {
        await tx
          .update(orders)
          .set({ customerId: target.id })
          .where(inArray(orders.id, ids.orders));
      }
      if (ids.sampleShipments.length > 0) {
        await tx
          .update(sampleShipments)
          .set({ customerId: target.id })
          .where(inArray(sampleShipments.id, ids.sampleShipments));
      }
      if (ids.receivables.length > 0) {
        await tx
          .update(receivables)
          .set({ customerId: target.id })
          .where(inArray(receivables.id, ids.receivables));
      }
      if (ids.items.length > 0) {
        await tx
          .update(items)
          .set({ customerId: target.id, updatedAt: new Date() })
          .where(inArray(items.id, ids.items));
      }
      if (ids.decisionDeltas.length > 0) {
        await tx
          .update(decisionDeltas)
          .set({ customerId: target.id })
          .where(inArray(decisionDeltas.id, ids.decisionDeltas));
      }
      // 入站消息不参与「业务历史」合并，但归属随客户走，客户 360 才不会断层。
      await tx
        .update(inboundMessages)
        .set({ customerId: target.id })
        .where(
          and(
            eq(inboundMessages.tenantId, this.tenantId),
            eq(inboundMessages.customerId, sourceCustomerId),
          ),
        );

      const sourceContacts = await tx
        .select()
        .from(customerContacts)
        .where(
          and(
            eq(customerContacts.tenantId, this.tenantId),
            eq(customerContacts.customerId, sourceCustomerId),
            isNull(customerContacts.archivedAt),
          ),
        );
      const conflicts = new Set(
        (await this.mergeContactConflicts(sourceCustomerId, target.id, tx)).map(
          (item) => item.contactId,
        ),
      );
      const movedContacts: string[] = [];
      const demotedPrimaryContacts: string[] = [];
      for (const contact of sourceContacts) {
        if (conflicts.has(contact.id)) continue;
        const demote = contact.isPrimary;
        await tx
          .update(customerContacts)
          .set({ customerId: target.id, isPrimary: false, updatedAt: new Date() })
          .where(eq(customerContacts.id, contact.id));
        movedContacts.push(contact.id);
        if (demote) demotedPrimaryContacts.push(contact.id);
      }

      await tx
        .update(customers)
        .set({ status: "ARCHIVED", updatedAt: new Date() })
        .where(eq(customers.id, sourceCustomerId));
      await appendAudit(
        tx,
        ctx,
        {
          action: "CUSTOMER_MERGED",
          entityType: "customer",
          entityId: sourceCustomerId,
          before: { status: source.status, name: source.name, code: source.code },
          after: {
            targetCustomerId: target.id,
            targetName: target.name,
            sourceStatusBefore: source.status,
            moved: ids,
            movedContacts,
            demotedPrimaryContacts,
            skippedContacts: [...conflicts],
          },
          entityLabel: source.name,
        },
        this.tenantId,
      );
      return {
        quotes: ids.quotes.length,
        orders: ids.orders.length,
        sampleShipments: ids.sampleShipments.length,
        receivables: ids.receivables.length,
        items: ids.items.length,
        contacts: movedContacts.length,
        decisionDeltas: ids.decisionDeltas.length,
        skippedContactCount: conflicts.size,
      };
    });

    const undoUntil = new Date(Date.now() + 10 * 60 * 1000);
    return CustomerMergeResult.parse({
      customer: mapCustomer(
        target,
        await loadPrimaryContactRow(this.db, this.tenantId, target.id),
        ctx.actor.role,
      ),
      moved: {
        quotes: moved.quotes,
        orders: moved.orders,
        sampleShipments: moved.sampleShipments,
        receivables: moved.receivables,
        items: moved.items,
        contacts: moved.contacts,
        decisionDeltas: moved.decisionDeltas,
      },
      skippedContactCount: moved.skippedContactCount,
      undoUntil: undoUntil.toISOString(),
      undoToken: createMergeToken(this.mergeSecret, {
        purpose: "undo",
        tenantId: this.tenantId,
        sourceCustomerId,
        targetCustomerId: target.id,
        exp: undoUntil.getTime(),
      }),
    });
  }

  /** 撤销窗口内完整回滚一次合并（依据审计行里的被迁移 id 列表）。 */
  async undoMerge(
    sourceCustomerId: string,
    input: unknown,
    ctx: KernelContext,
  ): Promise<CustomerMergeUndoResult> {
    const parsed = UndoCustomerMergeInput.parse(input);
    const payload = this.verifyToken(parsed.undoToken, "undo");
    if (payload.sourceCustomerId !== sourceCustomerId) {
      throw new KernelError("KERNEL_REJECTED", "撤销票据与客户不一致", {
        reason: "MERGE_UNDO_MISMATCH",
      });
    }
    const auditRows = await this.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, this.tenantId),
          eq(auditLog.entityId, sourceCustomerId),
          inArray(auditLog.action, ["CUSTOMER_MERGED", "CUSTOMER_MERGE_UNDONE"]),
        ),
      )
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const latest = auditRows[0];
    if (!latest || latest.action !== "CUSTOMER_MERGED") {
      throw new KernelError("KERNEL_REJECTED", "没有可撤销的合并，或已撤销过", {
        reason: "MERGE_UNDO_NOT_AVAILABLE",
      });
    }
    const snapshot = latest.after as unknown as {
      targetCustomerId: string;
      sourceStatusBefore: string;
      moved: Record<string, string[]>;
      movedContacts: string[];
      demotedPrimaryContacts: string[];
    } | null;
    if (!snapshot || snapshot.targetCustomerId !== payload.targetCustomerId) {
      throw new KernelError("KERNEL_REJECTED", "撤销票据与合并记录不一致", {
        reason: "MERGE_UNDO_MISMATCH",
      });
    }

    const reverted = await this.db.transaction(async (tx) => {
      const moved = snapshot.moved;
      const movedQuotes = moved.quotes ?? [];
      const movedOrders = moved.orders ?? [];
      const movedShipments = moved.sampleShipments ?? [];
      const movedReceivables = moved.receivables ?? [];
      const movedItems = moved.items ?? [];
      const movedDeltas = moved.decisionDeltas ?? [];
      if (movedQuotes.length > 0) {
        await tx
          .update(quotes)
          .set({ customerId: sourceCustomerId })
          .where(inArray(quotes.id, movedQuotes));
      }
      if (movedOrders.length > 0) {
        await tx
          .update(orders)
          .set({ customerId: sourceCustomerId })
          .where(inArray(orders.id, movedOrders));
      }
      if (movedShipments.length > 0) {
        await tx
          .update(sampleShipments)
          .set({ customerId: sourceCustomerId })
          .where(inArray(sampleShipments.id, movedShipments));
      }
      if (movedReceivables.length > 0) {
        await tx
          .update(receivables)
          .set({ customerId: sourceCustomerId })
          .where(inArray(receivables.id, movedReceivables));
      }
      if (movedItems.length > 0) {
        await tx
          .update(items)
          .set({ customerId: sourceCustomerId, updatedAt: new Date() })
          .where(inArray(items.id, movedItems));
      }
      if (movedDeltas.length > 0) {
        await tx
          .update(decisionDeltas)
          .set({ customerId: sourceCustomerId })
          .where(inArray(decisionDeltas.id, movedDeltas));
      }
      await tx
        .update(inboundMessages)
        .set({ customerId: sourceCustomerId })
        .where(eq(inboundMessages.customerId, payload.targetCustomerId));

      if (snapshot.movedContacts.length > 0) {
        await tx
          .update(customerContacts)
          .set({ customerId: sourceCustomerId, updatedAt: new Date() })
          .where(inArray(customerContacts.id, snapshot.movedContacts));
      }
      for (const contactId of snapshot.demotedPrimaryContacts) {
        await tx
          .update(customerContacts)
          .set({ isPrimary: true })
          .where(eq(customerContacts.id, contactId));
      }
      const restored = await tx
        .update(customers)
        .set({
          status: snapshot.sourceStatusBefore as "DRAFT" | "AVAILABLE" | "ARCHIVED",
          updatedAt: new Date(),
        })
        .where(and(eq(customers.id, sourceCustomerId), eq(customers.tenantId, this.tenantId)))
        .returning();
      const row = restored[0];
      if (!row) {
        throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${sourceCustomerId}`, {
          customerId: sourceCustomerId,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "CUSTOMER_MERGE_UNDONE",
          entityType: "customer",
          entityId: sourceCustomerId,
          before: { status: "ARCHIVED" },
          after: { status: row.status, targetCustomerId: payload.targetCustomerId },
          entityLabel: row.name,
        },
        this.tenantId,
      );
      return row;
    });

    return CustomerMergeUndoResult.parse({
      customer: mapCustomer(
        reverted,
        await loadPrimaryContactRow(this.db, this.tenantId, sourceCustomerId),
        ctx.actor.role,
      ),
      reverted: {
        quotes: (snapshot.moved.quotes ?? []).length,
        orders: (snapshot.moved.orders ?? []).length,
        sampleShipments: (snapshot.moved.sampleShipments ?? []).length,
        receivables: (snapshot.moved.receivables ?? []).length,
        items: (snapshot.moved.items ?? []).length,
        contacts: snapshot.movedContacts.length,
        decisionDeltas: (snapshot.moved.decisionDeltas ?? []).length,
      },
    });
  }

  private assertCanMerge(ctx: KernelContext): void {
    const role = ctx.actor.role;
    if (role && !hasCapability(role, "resource.merge")) {
      throw new KernelError("PERMISSION_DENIED", "当前角色不能合并客户（需要老板权限）");
    }
  }

  private verifyToken(token: string, purpose: "preview" | "undo") {
    try {
      const payload = verifyMergeToken(this.mergeSecret, token);
      if (payload.purpose !== purpose || payload.tenantId !== this.tenantId) {
        throw new Error("TOKEN_SCOPE_INVALID");
      }
      return payload;
    } catch {
      throw new KernelError("KERNEL_REJECTED", "预览已过期或无效，请重新预览", {
        reason: "MERGE_TOKEN_INVALID",
      });
    }
  }

  private async requireCustomerRow(customerId: string): Promise<CustomerRow> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("CUSTOMER_NOT_FOUND", `客户不存在：${customerId}`, { customerId });
    }
    return row;
  }

  private async mergeCounts(customerId: string) {
    const rows = await this.db.execute<{
      quotes: string;
      orders: string;
      sample_shipments: string;
      receivables: string;
      items: string;
      decision_deltas: string;
    }>(sql`
      SELECT
        (SELECT count(*) FROM quotes WHERE tenant_id = ${this.tenantId} AND customer_id = ${customerId}) AS quotes,
        (SELECT count(*) FROM orders WHERE tenant_id = ${this.tenantId} AND customer_id = ${customerId}) AS orders,
        (SELECT count(*) FROM sample_shipments WHERE tenant_id = ${this.tenantId} AND customer_id = ${customerId}) AS sample_shipments,
        (SELECT count(*) FROM receivables WHERE tenant_id = ${this.tenantId} AND customer_id = ${customerId}) AS receivables,
        (SELECT count(*) FROM items WHERE tenant_id = ${this.tenantId} AND customer_id = ${customerId}) AS items,
        (SELECT count(*) FROM decision_deltas WHERE tenant_id = ${this.tenantId} AND customer_id = ${customerId}) AS decision_deltas
    `);
    const row = rows.rows[0];
    return {
      quotes: Number(row?.quotes ?? 0),
      orders: Number(row?.orders ?? 0),
      sampleShipments: Number(row?.sample_shipments ?? 0),
      receivables: Number(row?.receivables ?? 0),
      items: Number(row?.items ?? 0),
      contacts: Number(
        (
          await this.db
            .select({ value: count() })
            .from(customerContacts)
            .where(
              and(
                eq(customerContacts.tenantId, this.tenantId),
                eq(customerContacts.customerId, customerId),
                isNull(customerContacts.archivedAt),
              ),
            )
        )[0]?.value ?? 0,
      ),
      decisionDeltas: Number(row?.decision_deltas ?? 0),
    };
  }

  private async mergeContactConflicts(
    sourceId: string,
    targetId: string,
    executor: Db | Tx = this.db,
  ) {
    const [sourceContacts, targetContacts] = [
      await executor
        .select()
        .from(customerContacts)
        .where(
          and(
            eq(customerContacts.tenantId, this.tenantId),
            eq(customerContacts.customerId, sourceId),
            isNull(customerContacts.archivedAt),
          ),
        ),
      await executor
        .select()
        .from(customerContacts)
        .where(
          and(
            eq(customerContacts.tenantId, this.tenantId),
            eq(customerContacts.customerId, targetId),
            isNull(customerContacts.archivedAt),
          ),
        ),
    ];
    const phones = new Set(
      targetContacts.map((row) => row.phoneNormalized).filter((value): value is string => !!value),
    );
    const emails = new Set(
      targetContacts
        .map((row) => row.email?.toLowerCase())
        .filter((value): value is string => !!value),
    );
    const targetHasPrimary = targetContacts.some((row) => row.isPrimary);
    const conflicts: Array<{ contactId: string; reason: "PHONE" | "EMAIL" | "PRIMARY" }> = [];
    for (const contact of sourceContacts) {
      const reason =
        contact.phoneNormalized && phones.has(contact.phoneNormalized)
          ? "PHONE"
          : contact.email && emails.has(contact.email.toLowerCase())
            ? "EMAIL"
            : contact.isPrimary && targetHasPrimary
              ? "PRIMARY"
              : null;
      if (reason) conflicts.push({ contactId: contact.id, reason });
    }
    return conflicts;
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
    const primary = await loadPrimaryContactRow(this.db, this.tenantId, customerId);
    return mapCustomer(row, primary, ctx?.actor.role);
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
      weight: weightMeasurementFrom(sample.weightValue, sample.weightUnit),
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
    // 顺序执行：RLS 会话绑定单连接，不能与上面的查询交错。
    const contacts = await loadActiveContacts(this.db, this.tenantId, customerId, ctx?.actor.role);
    return Customer360.parse({ customer, ownerId, ownerName, context, summary, contacts });
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
