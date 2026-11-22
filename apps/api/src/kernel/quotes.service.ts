import {
  customers,
  draftRevisions,
  items,
  memberships,
  quoteItems,
  quotes,
  revisionRequests,
  samples,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  ApprovalItem,
  CreateItemQuoteInput,
  DraftRevision,
  ItemQuoteListResponse,
  ItemQuoteRevisionResult,
  QuoteBasis,
  QuoteCopyText,
  QuoteApprovalView,
  QuoteDetail,
  QuoteListResponse,
  ReviseItemQuoteInput,
  ReviseQuoteDraftInput,
  RevisionDiff,
  T004GenerateQuoteDraftInput,
  approvalLevelRank,
  hasCapability,
  roleApprovalLevel,
} from "@weave-order/schema";
import type {
  ApprovalRequirement,
  Currency,
  EscalationReason,
  JsonValue,
  PricingContext,
  PricingKey,
  QuoteConfirmation,
  QuoteDraft,
  QuoteLineItem,
  QuoteListFilter,
  QuoteRevisionData,
  ResolvedPricingValue,
  Unit,
} from "@weave-order/schema";
import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { approvalListConditions } from "./approval-list";
import type { ApprovalListQuery } from "./approval-list";
import {
  assertCanApprove,
  assertCanEditQuote,
  computeRequirement,
  resolveApprovalPolicies,
} from "./approval-policy";
import { decodeCursor, encodeCursor, parseApprovalCursor } from "./cursor";
import { appendDecisionDeltaWithin } from "./decision-delta";
import type { CustomerService } from "./customers.service";
import { KernelError } from "./errors";
import { isOwnerInScope, ownerScopeFilter } from "./data-scope";
import { memberDisplayName } from "./member-label";
import { formatCents, formatMoney, milliToQuantity, multiplyCents, quantityToMilli } from "./money";
import { currencyOf, toIso, toIsoOrNull } from "./mappers";
import { isProductionLike } from "../platform/runtime-mode";
import { priceFloorOf, requireSampleCostFloor } from "./price-rules";
import { numericValue } from "./pricing.service";
import type { PricingService } from "./pricing.service";
import type { QuotePricingService } from "./quote-pricing.service";
import type { SampleService } from "./samples.service";

type QuoteRow = typeof quotes.$inferSelect;
type QuoteItemRow = typeof quoteItems.$inferSelect;
type DraftRevisionRow = typeof draftRevisions.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

interface BaselineItem {
  lineIndex: number;
  sampleId: string;
  description: string;
  quantityMilli: number;
  unit: Unit;
  unitPriceAmount: number;
  lineTotalAmount: number;
}

interface BaselineSnapshot {
  items: BaselineItem[];
  subtotalAmount: number;
  totalAmount: number;
  capturedAt: string;
}

interface CurrentLine {
  id: string | null;
  lineIndex: number;
  sampleId: string;
  description: string;
  quantityMilli: number;
  unit: Unit;
  unitPriceAmount: number;
  lineTotalAmount: number;
  provenance: JsonValue;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function parseBaseline(row: QuoteRow): BaselineSnapshot | null {
  const raw = row.baselineSnapshot;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const snapshot = raw as unknown as BaselineSnapshot;
  if (!Array.isArray(snapshot.items)) return null;
  return snapshot;
}

function lineFromRow(row: QuoteItemRow, lineIndex: number): CurrentLine {
  return {
    id: row.id,
    lineIndex,
    sampleId: row.sampleId,
    description: row.description,
    quantityMilli: row.quantityMilli,
    unit: row.unit,
    unitPriceAmount: row.unitPriceAmount,
    lineTotalAmount: row.lineTotalAmount,
    provenance: row.provenance,
  };
}

function mapLine(line: CurrentLine, currency: Currency): QuoteLineItem {
  return {
    id: line.id ?? undefined,
    lineIndex: line.lineIndex,
    fabricSampleId: line.sampleId,
    description: line.description,
    quantity: { value: milliToQuantity(line.quantityMilli), unit: line.unit },
    unitPrice: { amount: line.unitPriceAmount, currency },
    lineTotal: { amount: line.lineTotalAmount, currency },
    provenance: line.provenance as unknown as Record<string, unknown>,
  };
}

function mapQuote(
  row: QuoteRow,
  lines: CurrentLine[],
  requirement: ApprovalRequirement | null,
): QuoteDraft {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    status: "DRAFT",
    version: row.version,
    currency: row.currency,
    items: lines.map((line) => mapLine(line, row.currency)),
    subtotal: { amount: row.subtotalAmount, currency: row.currency },
    total: { amount: row.totalAmount, currency: row.currency },
    amountsComputedByKernel: true,
    validityDays: row.validityDays,
    expiresAt: toIso(row.expiresAt),
    createdAt: toIso(row.createdAt),
    remarks: row.remarks,
    approvalRequirement: requirement,
  };
}

/**
 * 一次审批要用到的要求。
 *
 * 草稿生成 / 改稿时是用完整上下文（person / category / team）算出审批角色后落库的；
 * 这里**以落库值为准**。只用 `customerId` 重算会丢掉更严的个人/品类限额，等于在批准
 * 那一刻把门槛偷偷降回去（业务员可自批超个人限额的报价）。重算结果更严时采信重算，
 * 保证任何口径变化都只会收紧、不会放宽。
 */
function requirementFromRow(
  row: QuoteRow,
  policies: Partial<Record<PricingKey, ResolvedPricingValue>>,
  baselineCents: number | null,
): ApprovalRequirement {
  const computed = computeRequirement({
    amountCents: row.totalAmount,
    baselineCents,
    policies,
    numeric: numericValue,
  });
  const storedRole = row.requiredApprovalRole;
  const storedLevel = storedRole === null ? null : roleApprovalLevel(storedRole);
  if (storedRole === null || storedLevel === null) return computed;

  const storedReasons = row.escalationReasons as EscalationReason[];
  const reasons = [...new Set<EscalationReason>([...storedReasons, ...computed.reasons])];
  const storedIsStricter = approvalLevelRank(storedLevel) >= approvalLevelRank(computed.level);
  const level = storedIsStricter ? storedLevel : computed.level;
  return {
    level,
    role: storedIsStricter ? storedRole : computed.role,
    amountCents: computed.amountCents,
    changePctBps: row.changePctBps ?? computed.changePctBps,
    escalated: level !== "SALES" || reasons.length > 0,
    reasons,
    policySources: computed.policySources,
  };
}

function diffBetween(
  baseline: BaselineSnapshot | null,
  lines: CurrentLine[],
  row: QuoteRow,
  currency: Currency,
): RevisionDiff[] {
  if (!baseline) return [];
  const diffs: RevisionDiff[] = [];
  const baselineByIndex = new Map(baseline.items.map((item) => [item.lineIndex, item]));
  for (const line of lines) {
    const before = baselineByIndex.get(line.lineIndex);
    if (!before) continue;
    if (before.sampleId !== line.sampleId) {
      diffs.push({
        field: `line[${line.lineIndex}].sampleId`,
        lineIndex: line.lineIndex,
        label: "样品",
        before: before.sampleId,
        after: line.sampleId,
      });
    }
    if (before.description !== line.description) {
      diffs.push({
        field: `line[${line.lineIndex}].description`,
        lineIndex: line.lineIndex,
        label: "品名",
        before: before.description,
        after: line.description,
      });
    }
    if (before.quantityMilli !== line.quantityMilli) {
      diffs.push({
        field: `line[${line.lineIndex}].quantity`,
        lineIndex: line.lineIndex,
        label: "数量",
        before: { value: milliToQuantity(before.quantityMilli), unit: before.unit },
        after: { value: milliToQuantity(line.quantityMilli), unit: line.unit },
      });
    }
    if (before.unitPriceAmount !== line.unitPriceAmount) {
      diffs.push({
        field: `line[${line.lineIndex}].unitPrice`,
        lineIndex: line.lineIndex,
        label: "单价",
        before: { amount: before.unitPriceAmount, currency },
        after: { amount: line.unitPriceAmount, currency },
      });
    }
  }
  if (baseline.totalAmount !== row.totalAmount) {
    diffs.push({
      field: "total",
      lineIndex: null,
      label: "总额",
      before: { amount: baseline.totalAmount, currency },
      after: { amount: row.totalAmount, currency },
    });
  }
  return diffs;
}

/**
 * 报价内核服务。
 *
 * 金额是内核算出来的，不是智能体填的：
 * - 行金额 = 整数分单价 × 千分之一数量，一次显式 half-up 舍入；
 * - 单价低于「样品成本底线 / 公司成本底线 / 最低毛利」一律 KERNEL_REJECTED；
 * - 草稿状态固定 DRAFT，人类 confirm 后才转 SENT。
 *
 * 改稿（reviseDraft）：
 * - 乐观锁 baseVersion，版本 +1；
 * - 同事务写 audit + revision_requests + draft_revisions + decision_deltas；
 * - 改幅超阈值时自动升级审批人（金额阈值与改幅阈值取较高者）。
 */
export class QuoteService {
  constructor(
    private readonly db: Db,
    private readonly customers: CustomerService,
    private readonly samples: SampleService,
    private readonly pricing: PricingService,
    private readonly quotePricing: QuotePricingService,
    private readonly tenantId: string,
  ) {}

  async generateDraft(input: unknown, ctx: KernelContext): Promise<QuoteDraft> {
    const parsed = T004GenerateQuoteDraftInput.parse(input);
    // 入口按驱动者的数据范围判客户归属：越权当成不存在（与其它读路径同一套语义），
    // 智能体因此不能替 OWN 成员碰同事名下的客户。定价计算本身仍不受范围限制。
    const customer = await this.customers.getById(parsed.customerId, ctx);

    // 事项内发起的报价必须真的挂在事项上，且客户与事项一致。
    // 不能默默忽略 itemId：那样事项完成校验会退回「客户 + 样品」的模糊匹配。
    let itemId: string | null = null;
    if (parsed.itemId) {
      const itemRows = await this.db
        .select()
        .from(items)
        .where(and(eq(items.id, parsed.itemId), eq(items.tenantId, this.tenantId)))
        .limit(1);
      const item = itemRows[0];
      if (!item) {
        throw new KernelError("RESOURCE_NOT_FOUND", `事项不存在：${parsed.itemId}`, {
          resourceType: "item",
          resourceId: parsed.itemId,
        });
      }
      if (item.customerId !== parsed.customerId) {
        throw new KernelError("KERNEL_REJECTED", "报价客户与事项客户不一致", {
          reason: "ITEM_CUSTOMER_MISMATCH",
        });
      }
      itemId = item.id;
    }

    const sampleIds = parsed.items.map((item) => item.fabricSampleId);
    const samplesById = await this.samples.getManyByIds(sampleIds);

    const minMarginByCategory = new Map<string, ResolvedPricingValue>();
    const companyFloorByCategory = new Map<string, ResolvedPricingValue>();

    const lineInputs: Array<{
      sampleId: string;
      position: number;
      description: string;
      quantityMilli: number;
      unit: Unit;
      unitPriceAmount: number;
      lineTotalAmount: number;
      provenance: JsonValue;
    }> = [];

    for (const [index, item] of parsed.items.entries()) {
      const sample = samplesById.get(item.fabricSampleId);
      if (!sample) {
        throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${item.fabricSampleId}`, {
          resourceType: "sample",
          resourceId: item.fabricSampleId,
        });
      }
      if (item.unitPrice.currency !== parsed.currency) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `第 ${index + 1} 行单价币种 ${item.unitPrice.currency} 与报价币种 ${parsed.currency} 不一致`,
          { reason: "CURRENCY_MISMATCH" },
        );
      }
      if (item.quantity.unit !== sample.unit) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `第 ${index + 1} 行数量单位 ${item.quantity.unit} 与样品 ${sample.code} 的单位 ${sample.unit} 不一致`,
          { reason: "UNIT_MISMATCH" },
        );
      }

      const category = sample.category ?? "";
      const pricingContext: PricingContext = {
        customerId: customer.id,
        personId: ctx.actor.id,
        ...(category ? { categoryId: category } : {}),
      };
      let minMargin = minMarginByCategory.get(category);
      if (!minMargin) {
        minMargin = await this.pricing.resolve("pricing.min_margin_pct", pricingContext);
        minMarginByCategory.set(category, minMargin);
      }
      let companyFloor = companyFloorByCategory.get(category);
      if (!companyFloor) {
        companyFloor = await this.pricing.resolve("pricing.cost_floor_amount", pricingContext);
        companyFloorByCategory.set(category, companyFloor);
      }

      // 缺失 / 为 0 的成本底线直接拒绝：没有下限不等于什么价都能批（与 T-006 同口径）。
      requireSampleCostFloor(sample, parsed.currency);
      const floor = priceFloorOf(
        sample,
        parsed.currency,
        numericValue(minMargin.value) ?? 0,
        numericValue(companyFloor.value) ?? 0,
      );
      if (item.unitPrice.amount < floor) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `第 ${index + 1} 行单价低于成本底线/最低毛利：${item.unitPrice.amount} < ${floor}（分）`,
          { reason: "PRICE_BELOW_COST_FLOOR" },
        );
      }

      const quantityMilli = quantityToMilli(item.quantity.value);
      const lineTotalAmount = multiplyCents(item.unitPrice.amount, quantityMilli);
      lineInputs.push({
        sampleId: sample.id,
        position: index,
        description: sample.name,
        quantityMilli,
        unit: item.quantity.unit,
        unitPriceAmount: item.unitPrice.amount,
        lineTotalAmount,
        provenance: asJson({
          sample: {
            source: "SAMPLE",
            sampleId: sample.id,
            code: sample.code,
            name: sample.name,
            costFloor: sample.costFloor,
          },
          unitPrice: {
            source: "AGENT_SUGGESTION",
            actorId: ctx.actor.id,
            actorType: ctx.actor.type,
            amount: item.unitPrice.amount,
            currency: parsed.currency,
            floorCents: floor,
            minMarginPct: numericValue(minMargin.value) ?? 0,
            minMarginSource: minMargin.source,
            companyCostFloorSource: companyFloor.source,
          },
          quantity: {
            source: "AGENT_SUGGESTION",
            actorId: ctx.actor.id,
            value: item.quantity.value,
            unit: item.quantity.unit,
          },
        }),
      });
    }

    const subtotalAmount = lineInputs.reduce((sum, line) => sum + line.lineTotalAmount, 0);
    const totalAmount = subtotalAmount;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + parsed.validityDays * DAY_MS);

    const approvalPolicies = await resolveApprovalPolicies(this.pricing, {
      customerId: customer.id,
      personId: ctx.actor.id,
    });
    const requirement = computeRequirement({
      amountCents: totalAmount,
      baselineCents: null,
      policies: approvalPolicies,
      numeric: numericValue,
    });

    const baseline: BaselineSnapshot = {
      items: lineInputs.map((line, index) => ({
        lineIndex: index,
        sampleId: line.sampleId,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPriceAmount: line.unitPriceAmount,
        lineTotalAmount: line.lineTotalAmount,
      })),
      subtotalAmount,
      totalAmount,
      capturedAt: createdAt.toISOString(),
    };

    return this.db.transaction(async (tx) => {
      const quoteRows = await tx
        .insert(quotes)
        .values({
          tenantId: this.tenantId,
          customerId: parsed.customerId,
          itemId,
          status: "DRAFT",
          currency: parsed.currency,
          subtotalAmount,
          totalAmount,
          version: 1,
          baselineSnapshot: asJson(baseline),
          pendingDiff: [],
          requiredApprovalRole: requirement.role,
          approvalEscalated: requirement.escalated,
          escalationReasons: requirement.reasons,
          changePctBps: null,
          validityDays: parsed.validityDays,
          expiresAt,
          remarks: parsed.remarks ?? null,
        })
        .returning();
      const quoteRow = quoteRows[0];
      if (!quoteRow) {
        throw new KernelError("KERNEL_REJECTED", "报价写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }

      const inserted = await tx
        .insert(quoteItems)
        .values(
          lineInputs.map((line) => ({
            tenantId: this.tenantId,
            quoteId: quoteRow.id,
            sampleId: line.sampleId,
            position: line.position,
            description: line.description,
            quantityMilli: line.quantityMilli,
            unit: line.unit,
            unitPriceAmount: line.unitPriceAmount,
            lineTotalAmount: line.lineTotalAmount,
            provenance: line.provenance,
          })),
        )
        .returning();

      await appendAudit(
        tx,
        ctx,
        {
          action: "QUOTE_DRAFT_GENERATED",
          entityType: "quote",
          entityId: quoteRow.id,
          before: null,
          after: {
            customerId: quoteRow.customerId,
            status: quoteRow.status,
            totalAmount,
            currency: quoteRow.currency,
            lineCount: inserted.length,
            requiredApprovalRole: requirement.role,
          },
        },
        this.tenantId,
      );

      const lines = inserted
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((row, index) => lineFromRow(row, index));
      return mapQuote(quoteRow, lines, requirement);
    });
  }

  /** 只读详情：任何合法状态都读得到（批准后 SENT 也要能在单据页看到完整行项）。 */
  async get(quoteId: string, ctx?: KernelContext): Promise<QuoteDetail> {
    const { row, lines } = await this.loadQuote(quoteId, ctx);
    const baseline = parseBaseline(row);
    const policies = await resolveApprovalPolicies(this.pricing, {
      customerId: row.customerId,
    });
    const requirement = requirementFromRow(row, policies, baseline?.totalAmount ?? null);
    const names = await this.confirmedNames([row.confirmedBy]);
    return QuoteDetail.parse({
      draft: mapQuote(row, lines, requirement),
      version: row.version,
      status: row.status,
      itemId: row.itemId,
      quoteNumber: quoteNumberOf(row),
      confirmedBy: row.confirmedBy,
      confirmedByName: row.confirmedBy ? (names.get(row.confirmedBy) ?? null) : null,
      confirmedAt: toIsoOrNull(row.confirmedAt),
      baselineTotal: baseline ? { amount: baseline.totalAmount, currency: row.currency } : null,
      pendingDiff: (row.pendingDiff as unknown as RevisionDiff[]) ?? [],
    });
  }

  /** 事项内发起报价：数量取事项，价格可由用户指定或由内核给建议价。 */
  async createForItem(itemId: string, input: unknown, ctx: KernelContext): Promise<QuoteDetail> {
    const parsed = CreateItemQuoteInput.parse(input);
    const itemRows = await this.db
      .select()
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
      .limit(1);
    const item = itemRows[0];
    if (!item) {
      throw new KernelError("RESOURCE_NOT_FOUND", `事项不存在：${itemId}`, {
        resourceType: "item",
        resourceId: itemId,
      });
    }
    if (item.status === "COMPLETED" || item.status === "CLOSED") {
      throw new KernelError("KERNEL_REJECTED", "已结束的事项不能再发起报价", {
        reason: "ITEM_TERMINAL",
      });
    }
    if (!item.customerId || !item.sampleId || item.quantityMilli === null) {
      throw new KernelError("KERNEL_REJECTED", "事项还缺客户、样品或数量，不能发起报价", {
        reason: "ITEM_INCOMPLETE",
      });
    }

    const quantity = parsed.quantity ?? {
      value: milliToQuantity(item.quantityMilli),
      unit: item.unit,
    };
    if (quantity.unit !== item.unit) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `数量单位 ${quantity.unit} 与事项单位 ${item.unit} 不一致`,
        { reason: "UNIT_MISMATCH" },
      );
    }

    let unitPrice = parsed.unitPrice;
    if (!unitPrice) {
      const suggested = await this.quotePricing.suggestLinePrice({
        customerId: item.customerId,
        fabricSampleId: item.sampleId,
        quantity,
        currency: parsed.currency,
      });
      unitPrice = suggested.suggestedUnitPrice;
    }

    const remarks = [parsed.remarks, parsed.rawText].filter(Boolean).join("；");
    const draft = await this.generateDraft(
      {
        customerId: item.customerId,
        itemId,
        currency: parsed.currency,
        validityDays: parsed.validityDays,
        ...(remarks ? { remarks } : {}),
        items: [
          {
            fabricSampleId: item.sampleId,
            quantity,
            unitPrice,
          },
        ],
      },
      ctx,
    );
    return this.get(draft.id);
  }

  /** 事项下的报价版本列表（同一事项可以有多份，直到其中一份被确认）。 */
  async listForItem(itemId: string): Promise<ItemQuoteListResponse> {
    const itemRows = await this.db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.tenantId, this.tenantId)))
      .limit(1);
    if (!itemRows[0]) {
      throw new KernelError("RESOURCE_NOT_FOUND", `事项不存在：${itemId}`, {
        resourceType: "item",
        resourceId: itemId,
      });
    }
    const rows = await this.db
      .select()
      .from(quotes)
      .where(and(eq(quotes.tenantId, this.tenantId), eq(quotes.itemId, itemId)))
      .orderBy(desc(quotes.createdAt), desc(quotes.id));
    const names = await this.confirmedNames(rows.map((row) => row.confirmedBy));
    return ItemQuoteListResponse.parse({
      quotes: rows.map((row) => ({
        id: row.id,
        itemId: row.itemId,
        quoteNumber: quoteNumberOf(row),
        status: row.status,
        currency: currencyOf(row.currency),
        total: { amount: row.totalAmount, currency: row.currency },
        version: row.version,
        expiresAt: toIso(row.expiresAt),
        createdAt: toIso(row.createdAt),
        confirmedBy: row.confirmedBy,
        confirmedByName: row.confirmedBy ? (names.get(row.confirmedBy) ?? null) : null,
        confirmedAt: toIsoOrNull(row.confirmedAt),
      })),
    });
  }

  /**
   * 报价依据（实时查，不缓存）。
   *
   * 历史成交只取同租户、同样品、已确认（SENT/ACCEPTED）的报价；
   * 成本底线与毛利按当前生效策略现算，和「改价时内核校验」同一口径。
   */
  async basis(quoteId: string, ctx?: KernelContext): Promise<QuoteBasis> {
    const { row, lines } = await this.loadQuote(quoteId, ctx);
    const sampleRows = await this.db
      .select()
      .from(samples)
      .where(
        and(
          eq(samples.tenantId, this.tenantId),
          inArray(
            samples.id,
            lines.map((line) => line.sampleId),
          ),
        ),
      );
    const sampleById = new Map(sampleRows.map((sample) => [sample.id, sample]));

    const basisLines = [];
    for (const line of lines) {
      const sample = sampleById.get(line.sampleId);
      const sampleFloor = requireSampleCostFloor(sample, row.currency);
      const pricingContext: PricingContext = {
        customerId: row.customerId,
        ...(sample?.category ? { categoryId: sample.category } : {}),
      };
      const marginResolved = await this.pricing.resolve("pricing.min_margin_pct", pricingContext);
      const companyFloorResolved = await this.pricing.resolve(
        "pricing.cost_floor_amount",
        pricingContext,
      );
      const minMarginPct = numericValue(marginResolved.value);
      const companyFloor = numericValue(companyFloorResolved.value) ?? 0;
      const priceFloor = priceFloorOf(sample, row.currency, minMarginPct ?? 0, companyFloor);
      const marginAmount = line.unitPriceAmount - sampleFloor;
      basisLines.push({
        lineIndex: line.lineIndex,
        sampleId: line.sampleId,
        sampleCode: sample?.code ?? "—",
        sampleName: sample?.name ?? line.description,
        quantity: { value: milliToQuantity(line.quantityMilli), unit: line.unit },
        unitPrice: { amount: line.unitPriceAmount, currency: row.currency },
        lineTotal: { amount: line.lineTotalAmount, currency: row.currency },
        sampleCostFloor: { amount: sampleFloor, currency: row.currency },
        companyCostFloor: { amount: companyFloor, currency: row.currency },
        priceFloor: { amount: priceFloor, currency: row.currency },
        minMarginPct,
        marginAmount: { amount: marginAmount, currency: row.currency },
        marginBps:
          line.unitPriceAmount > 0 ? Math.round((marginAmount * 10_000) / line.unitPriceAmount) : 0,
        floorSource: `samples.cost_floor(${sample?.code ?? "?"}) + pricing_policies.min_margin_pct（${marginResolved.source.scopeType}）`,
      });
    }

    const sampleIds = [...new Set(lines.map((line) => line.sampleId))];
    const historyRows =
      sampleIds.length > 0
        ? await this.db
            .select({
              quoteId: quotes.id,
              quoteCreatedAt: quotes.createdAt,
              status: quotes.status,
              confirmedAt: quotes.confirmedAt,
              customerName: customers.name,
              quantityMilli: quoteItems.quantityMilli,
              unit: quoteItems.unit,
              unitPriceAmount: quoteItems.unitPriceAmount,
            })
            .from(quoteItems)
            .innerJoin(quotes, eq(quoteItems.quoteId, quotes.id))
            .innerJoin(customers, eq(quotes.customerId, customers.id))
            .where(
              and(
                eq(quotes.tenantId, this.tenantId),
                inArray(quoteItems.sampleId, sampleIds),
                inArray(quotes.status, ["SENT", "ACCEPTED"]),
                sql`${quotes.id} <> ${quoteId}`,
              ),
            )
            .orderBy(desc(quotes.confirmedAt), desc(quotes.createdAt))
            .limit(10)
        : [];

    const history = historyRows.map((entry) => ({
      quoteId: entry.quoteId,
      // 历史行只需要稳定编号，按 id 段取即可。
      quoteNumber: quoteNumberOf({ id: entry.quoteId, createdAt: entry.quoteCreatedAt }),
      customerName: entry.customerName,
      status: entry.status,
      unitPrice: { amount: entry.unitPriceAmount, currency: row.currency },
      quantity: { value: milliToQuantity(entry.quantityMilli), unit: entry.unit },
      confirmedAt: toIso(entry.confirmedAt ?? entry.quoteCreatedAt),
    }));
    const lastDeal = history[0];

    return QuoteBasis.parse({
      quoteId,
      itemId: row.itemId,
      currency: row.currency,
      generatedAt: new Date().toISOString(),
      lines: basisLines,
      history,
      lastDealUnitPrice: lastDeal?.unitPrice ?? null,
      lastDealAt: lastDeal?.confirmedAt ?? null,
    });
  }

  /** 改价：保留 baselineSnapshot，返回「原价 → 新价 → 差额」。 */
  async reviseForItem(
    quoteId: string,
    input: unknown,
    ctx: KernelContext,
  ): Promise<ItemQuoteRevisionResult> {
    const parsed = ReviseItemQuoteInput.parse(input);
    // 先读改前状态：改价后同一行已经变了，「原价」必须来自改前的账本。
    const before = await this.loadQuote(quoteId, ctx);
    const sampleRows = await this.db
      .select({ id: samples.id, code: samples.code })
      .from(samples)
      .where(
        and(
          eq(samples.tenantId, this.tenantId),
          inArray(
            samples.id,
            before.lines.map((line) => line.sampleId),
          ),
        ),
      );
    const codeBySample = new Map(sampleRows.map((sample) => [sample.id, sample.code]));
    const result = await this.reviseDraft(
      {
        quoteId,
        baseVersion: parsed.baseVersion,
        source: "INLINE",
        instruction: parsed.note ?? "事项内改价",
        lines: parsed.lines,
        ...(parsed.validityDays ? { validityDays: parsed.validityDays } : {}),
        ...(parsed.remarks !== undefined ? { remarks: parsed.remarks } : {}),
      },
      ctx,
    );
    const changes = parsed.lines.map((patch) => {
      const previous = before.lines[patch.lineIndex];
      const next = result.draft.items.find((item) => item.lineIndex === patch.lineIndex);
      if (!previous || !next) {
        throw new KernelError("KERNEL_REJECTED", `行号越界：${patch.lineIndex}`, {
          reason: "LINE_INDEX_OUT_OF_RANGE",
        });
      }
      const beforeAmount = previous.unitPriceAmount;
      const delta = next.unitPrice.amount - beforeAmount;
      return {
        lineIndex: patch.lineIndex,
        sampleCode: codeBySample.get(previous.sampleId) ?? "—",
        beforeUnitPrice: { amount: beforeAmount, currency: before.row.currency },
        afterUnitPrice: next.unitPrice,
        delta: { amount: delta, currency: before.row.currency },
        deltaPctBps: beforeAmount > 0 ? Math.round((delta * 10_000) / beforeAmount) : 0,
        beforeLineTotal: {
          amount: previous.lineTotalAmount,
          currency: before.row.currency,
        },
        afterLineTotal: next.lineTotal,
      };
    });
    return ItemQuoteRevisionResult.parse({
      quoteId,
      version: result.draft.version,
      status: result.draft.status,
      total: result.draft.total,
      changes,
    });
  }

  /** 复制文本：纯文本 + 编号 / 客户 / 样品 / 数量 / 单价 / 合计 / 有效期。 */
  async copyText(quoteId: string, ctx?: KernelContext): Promise<QuoteCopyText> {
    const { row, lines } = await this.loadQuote(quoteId, ctx);
    const [customer] = await this.db
      .select({ name: customers.name })
      .from(customers)
      .where(and(eq(customers.id, row.customerId), eq(customers.tenantId, this.tenantId)))
      .limit(1);
    const sampleRows = await this.db
      .select({ id: samples.id, code: samples.code, name: samples.name })
      .from(samples)
      .where(
        and(
          eq(samples.tenantId, this.tenantId),
          inArray(
            samples.id,
            lines.map((line) => line.sampleId),
          ),
        ),
      );
    const sampleById = new Map(sampleRows.map((sample) => [sample.id, sample]));
    const quoteNumber = quoteNumberOf(row);
    const unitLabel = (unit: string) =>
      ({ meter: "米", kilogram: "公斤", yard: "码", piece: "件" })[unit] ?? unit;
    const quantityText = lines
      .map((line) => `${milliToQuantity(line.quantityMilli)} ${unitLabel(line.unit)}`)
      .join(" + ");
    const unitPriceText = lines
      .map((line) => `¥${formatCents(line.unitPriceAmount)}/${unitLabel(line.unit)}`)
      .join("；");
    const totalText = `¥${formatCents(row.totalAmount)}`;
    const expiresDay = row.expiresAt.toISOString().slice(0, 10);
    const text = [
      `【报价单 ${quoteNumber}】`,
      `客户：${customer?.name ?? "—"}`,
      ...lines.map((line, index) => {
        const sample = sampleById.get(line.sampleId);
        return `样品 ${index + 1}：${sample?.name ?? line.description}（${sample?.code ?? "—"}）`;
      }),
      `数量：${quantityText}`,
      `单价：${unitPriceText}`,
      `合计：${totalText}`,
      `有效期：${row.validityDays} 天（至 ${expiresDay}）`,
      "价格含税，大货交期以确认后回签为准。",
    ].join("\n");

    return QuoteCopyText.parse({
      quoteId,
      quoteNumber,
      customerName: customer?.name ?? "—",
      sampleNames: lines.map((line) => sampleById.get(line.sampleId)?.name ?? line.description),
      quantityText,
      unitPriceText,
      totalText,
      validityDays: row.validityDays,
      expiresAt: toIso(row.expiresAt),
      text,
    });
  }

  /** 审批卡详情：只读，逐行 diff + 每个数字的出处。 */
  async getApprovalView(quoteId: string, ctx?: KernelContext): Promise<QuoteApprovalView> {
    const { row, lines } = await this.loadQuote(quoteId, ctx);
    const baseline = parseBaseline(row);
    const policies = await resolveApprovalPolicies(this.pricing, {
      customerId: row.customerId,
    });
    const requirement = requirementFromRow(row, policies, baseline?.totalAmount ?? null);
    const revisionRows = await this.db
      .select()
      .from(draftRevisions)
      .where(
        and(
          eq(draftRevisions.tenantId, this.tenantId),
          eq(draftRevisions.entityType, "quote"),
          eq(draftRevisions.entityId, quoteId),
        ),
      )
      .orderBy(asc(draftRevisions.version));
    return QuoteApprovalView.parse({
      quoteId: row.id,
      version: row.version,
      status: row.status,
      customerId: row.customerId,
      currency: row.currency,
      subtotal: { amount: row.subtotalAmount, currency: row.currency },
      total: { amount: row.totalAmount, currency: row.currency },
      items: lines.map((line) => ({
        lineIndex: line.lineIndex,
        sampleId: line.sampleId,
        description: line.description,
        quantity: { value: milliToQuantity(line.quantityMilli), unit: line.unit },
        unitPrice: { amount: line.unitPriceAmount, currency: row.currency },
        lineTotal: { amount: line.lineTotalAmount, currency: row.currency },
        provenance: line.provenance,
      })),
      diff: (row.pendingDiff as unknown as RevisionDiff[]) ?? [],
      requirement,
      revisions: revisionRows.map(mapDraftRevision),
      updatedAt: toIso(row.updatedAt),
    });
  }

  /**
   * 人类改稿：版本 +1、重算、同事务审计。
   * AI 只产出 Patch，不能调用这里直接改账本（G10）。
   */
  async reviseDraft(input: unknown, ctx: KernelContext): Promise<QuoteRevisionData> {
    // 改稿是账本写入（版本 +1、审计、决策差额），先过能力门再解析输入：
    // 非报价角色（merchandiser / sample_admin / finance / viewer）连参数都不该看到被校验。
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "改稿必须由人类确认后执行；智能体只能产出 Patch（G10）",
      );
    }
    assertCanEditQuote(ctx.actor.role);
    const parsed = ReviseQuoteDraftInput.parse(input);

    return this.db.transaction(async (tx) => {
      const quoteRows = await tx
        .select()
        .from(quotes)
        .where(and(eq(quotes.id, parsed.quoteId), eq(quotes.tenantId, this.tenantId)))
        .limit(1)
        .for("update");
      const row = quoteRows[0];
      if (!row) {
        throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${parsed.quoteId}`, {
          resourceType: "quote",
          resourceId: parsed.quoteId,
        });
      }
      // 报价没有自己的归属人列：归属随客户（与 list / loadQuote 同口径）。
      // 看得到不等于改得了 —— dataScope=OWN 的成员只能改自己名下客户的草稿；
      // 越权一律当作「不存在」返回，不给 403 枚举同租户单据的机会。
      const ownerRows = await tx
        .select({ ownerId: customers.ownerId })
        .from(customers)
        .where(and(eq(customers.id, row.customerId), eq(customers.tenantId, this.tenantId)))
        .limit(1);
      const ownerId = ownerRows[0]?.ownerId ?? null;
      if (!(await isOwnerInScope(tx, ctx, this.tenantId, ownerId))) {
        throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${parsed.quoteId}`, {
          resourceType: "quote",
          resourceId: parsed.quoteId,
        });
      }
      if (row.status !== "DRAFT") {
        throw new KernelError("KERNEL_REJECTED", `报价单不是草稿状态：${row.status}`, {
          reason: "INVALID_STATE_TRANSITION",
        });
      }
      if (row.version !== parsed.baseVersion) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `版本冲突：当前 v${row.version}，提交基于 v${parsed.baseVersion}`,
          { reason: "VERSION_CONFLICT" },
        );
      }

      const itemRows = await tx
        .select()
        .from(quoteItems)
        .where(eq(quoteItems.quoteId, parsed.quoteId))
        .orderBy(asc(quoteItems.position));
      const lines = itemRows.map((item, index) => lineFromRow(item, index));

      const sampleIds = new Set(lines.map((line) => line.sampleId));
      for (const patch of parsed.lines ?? []) {
        if (patch.fabricSampleId) sampleIds.add(patch.fabricSampleId);
      }
      const sampleRows = await tx
        .select()
        .from(samples)
        .where(and(eq(samples.tenantId, this.tenantId), inArray(samples.id, [...sampleIds])));
      const samplesById = new Map(sampleRows.map((sample) => [sample.id, sample]));

      const baseline = parseBaseline(row);
      const beforeSnapshot = asJson({
        version: row.version,
        subtotalAmount: row.subtotalAmount,
        totalAmount: row.totalAmount,
        items: lines.map((line) => ({
          lineIndex: line.lineIndex,
          sampleId: line.sampleId,
          description: line.description,
          quantityMilli: line.quantityMilli,
          unit: line.unit,
          unitPriceAmount: line.unitPriceAmount,
          lineTotalAmount: line.lineTotalAmount,
        })),
        remarks: row.remarks,
        validityDays: row.validityDays,
      });

      const minMarginByCategory = new Map<string, ResolvedPricingValue>();
      const companyFloorByCategory = new Map<string, ResolvedPricingValue>();
      /**
       * 每行的价格下限。改单价、换样、改数量任何一项都会影响是否合规，
       * 所以下限不跟着 patch 走：落库前对所有行统一重算，换样后低于新样品底线同样被拒。
       * 缺失 / 为 0 的成本底线直接拒绝，与 T-004 / T-006 同口径。
       */
      const floorBySample = new Map<string, number>();
      const floorForSample = async (
        sample: (typeof sampleRows)[number] | undefined,
      ): Promise<number> => {
        const key = sample?.id ?? "";
        const cached = floorBySample.get(key);
        if (cached !== undefined) return cached;
        requireSampleCostFloor(sample, row.currency);
        const category = sample?.category ?? "";
        const pricingContext: PricingContext = {
          customerId: row.customerId,
          personId: ctx.actor.id,
          ...(category ? { categoryId: category } : {}),
        };
        let minMargin = minMarginByCategory.get(category);
        if (!minMargin) {
          minMargin = await this.pricing.resolve("pricing.min_margin_pct", pricingContext);
          minMarginByCategory.set(category, minMargin);
        }
        let companyFloor = companyFloorByCategory.get(category);
        if (!companyFloor) {
          companyFloor = await this.pricing.resolve("pricing.cost_floor_amount", pricingContext);
          companyFloorByCategory.set(category, companyFloor);
        }
        const floor = priceFloorOf(
          sample,
          row.currency,
          numericValue(minMargin.value) ?? 0,
          numericValue(companyFloor.value) ?? 0,
        );
        floorBySample.set(key, floor);
        return floor;
      };
      const priceChanges: Array<{
        lineIndex: number;
        beforeAmount: number;
        afterAmount: number;
      }> = [];

      for (const patch of parsed.lines ?? []) {
        const line = lines[patch.lineIndex];
        if (!line) {
          throw new KernelError("KERNEL_REJECTED", `行号越界：${patch.lineIndex}`, {
            reason: "LINE_INDEX_OUT_OF_RANGE",
          });
        }
        if (patch.fabricSampleId && patch.fabricSampleId !== line.sampleId) {
          const nextSample = samplesById.get(patch.fabricSampleId);
          if (!nextSample) {
            throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${patch.fabricSampleId}`, {
              resourceType: "sample",
              resourceId: patch.fabricSampleId,
            });
          }
          // 换样且单位不同：数量必须显式折算，否则 1000 meter 会悄悄变成 1000 kilogram，
          // 行金额不变、diff 也看不出，客户拿到的其实是另一回事。
          if (nextSample.unit !== line.unit && !patch.quantity) {
            throw new KernelError(
              "KERNEL_REJECTED",
              `第 ${line.lineIndex + 1} 行换样后单位由 ${line.unit} 变为 ${nextSample.unit}，必须显式给出折算后的数量`,
              { reason: "UNIT_MISMATCH" },
            );
          }
          if (patch.quantity && patch.quantity.unit !== nextSample.unit) {
            throw new KernelError("KERNEL_REJECTED", `数量单位与样品 ${nextSample.code} 不一致`, {
              reason: "UNIT_MISMATCH",
            });
          }
          const previous = provenanceRecord(line.provenance);
          line.sampleId = nextSample.id;
          line.unit = nextSample.unit;
          line.description = patch.description ?? nextSample.name;
          line.provenance = asJson({
            ...previous,
            sample: {
              source: "SAMPLE",
              sampleId: nextSample.id,
              code: nextSample.code,
              name: nextSample.name,
              costFloor: {
                amount: nextSample.costFloorAmount,
                currency: nextSample.costFloorCurrency,
              },
            },
            sampleEdit: {
              source: "HUMAN_EDIT",
              actorId: ctx.actor.id,
              version: row.version + 1,
              previousSampleId: provenanceRecord(previous.sample ?? null).sampleId ?? null,
            },
          });
        } else if (patch.description !== undefined) {
          line.description = patch.description;
        }
        if (patch.quantity) {
          if (patch.quantity.unit !== line.unit) {
            throw new KernelError(
              "KERNEL_REJECTED",
              `第 ${line.lineIndex + 1} 行数量单位 ${patch.quantity.unit} 与样品单位 ${line.unit} 不一致`,
              { reason: "UNIT_MISMATCH" },
            );
          }
          const previousMilli = line.quantityMilli;
          line.quantityMilli = quantityToMilli(patch.quantity.value);
          line.provenance = asJson({
            ...provenanceRecord(line.provenance),
            quantity: {
              source: "HUMAN_EDIT",
              actorId: ctx.actor.id,
              version: row.version + 1,
              previousValue: milliToQuantity(previousMilli),
              value: patch.quantity.value,
              unit: patch.quantity.unit,
            },
          });
        }
        if (patch.unitPrice) {
          if (patch.unitPrice.currency !== row.currency) {
            throw new KernelError(
              "KERNEL_REJECTED",
              `第 ${line.lineIndex + 1} 行单价币种与报价币种不一致`,
              { reason: "CURRENCY_MISMATCH" },
            );
          }
          const previousAmount = line.unitPriceAmount;
          const sample = samplesById.get(line.sampleId);
          const floor = await floorForSample(sample);
          const minMargin = minMarginByCategory.get(sample?.category ?? "") as ResolvedPricingValue;
          line.unitPriceAmount = patch.unitPrice.amount;
          line.provenance = asJson({
            ...provenanceRecord(line.provenance),
            unitPrice: {
              source: "HUMAN_EDIT",
              actorId: ctx.actor.id,
              version: row.version + 1,
              previousValue: previousAmount,
              value: patch.unitPrice.amount,
              currency: row.currency,
              floorCents: floor,
              minMarginPct: numericValue(minMargin.value) ?? 0,
              minMarginSource: minMargin.source,
            },
          });
          priceChanges.push({
            lineIndex: line.lineIndex,
            beforeAmount: previousAmount,
            afterAmount: patch.unitPrice.amount,
          });
        }
      }

      // 落库前对所有行统一复核价格下限：不依赖本次是否传了单价，
      // 换样后单价没动但新样品底线更高的行也会在这里被拦下。
      for (const line of lines) {
        const floor = await floorForSample(samplesById.get(line.sampleId));
        if (line.unitPriceAmount < floor) {
          throw new KernelError(
            "KERNEL_REJECTED",
            `第 ${line.lineIndex + 1} 行单价低于成本底线/最低毛利：${line.unitPriceAmount} < ${floor}（分）`,
            { reason: "PRICE_BELOW_COST_FLOOR" },
          );
        }
        line.lineTotalAmount = multiplyCents(line.unitPriceAmount, line.quantityMilli);
      }
      const subtotalAmount = lines.reduce((sum, line) => sum + line.lineTotalAmount, 0);
      const totalAmount = subtotalAmount;
      const newVersion = row.version + 1;
      const validityDays = parsed.validityDays ?? row.validityDays;
      const remarks = parsed.remarks !== undefined ? parsed.remarks : row.remarks;
      const expiryBase = parsed.validityDays !== undefined ? new Date() : row.createdAt;
      const expiresAt = new Date(expiryBase.getTime() + validityDays * DAY_MS);

      const updatedRows = await tx
        .update(quotes)
        .set({
          subtotalAmount,
          totalAmount,
          version: newVersion,
          validityDays,
          remarks,
          expiresAt,
          lastRevisedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(quotes.id, row.id), eq(quotes.version, row.version)))
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new KernelError("KERNEL_REJECTED", "版本冲突：报价已被其他人修改", {
          reason: "VERSION_CONFLICT",
        });
      }

      for (const line of lines) {
        if (!line.id) continue;
        await tx
          .update(quoteItems)
          .set({
            sampleId: line.sampleId,
            description: line.description,
            quantityMilli: line.quantityMilli,
            unit: line.unit,
            unitPriceAmount: line.unitPriceAmount,
            lineTotalAmount: line.lineTotalAmount,
            provenance: line.provenance,
          })
          .where(eq(quoteItems.id, line.id));
      }

      const diff = diffBetween(baseline, lines, updated, row.currency);
      const baselineCents = baseline?.totalAmount ?? row.totalAmount;
      const approvalPolicies = await resolveApprovalPolicies(this.pricing, {
        customerId: row.customerId,
        personId: ctx.actor.id,
      });
      const requirement = computeRequirement({
        amountCents: totalAmount,
        baselineCents,
        policies: approvalPolicies,
        numeric: numericValue,
      });

      await tx
        .update(quotes)
        .set({
          requiredApprovalRole: requirement.role,
          approvalEscalated: requirement.escalated,
          escalationReasons: requirement.reasons,
          changePctBps: requirement.changePctBps,
          pendingDiff: asJson(diff),
        })
        .where(eq(quotes.id, row.id));

      const afterSnapshot = asJson({
        version: newVersion,
        subtotalAmount,
        totalAmount,
        items: lines.map((line) => ({
          lineIndex: line.lineIndex,
          sampleId: line.sampleId,
          description: line.description,
          quantityMilli: line.quantityMilli,
          unit: line.unit,
          unitPriceAmount: line.unitPriceAmount,
          lineTotalAmount: line.lineTotalAmount,
        })),
        remarks,
        validityDays,
      });

      const revisionRows = await tx
        .insert(draftRevisions)
        .values({
          tenantId: this.tenantId,
          entityType: "quote",
          entityId: row.id,
          version: newVersion,
          patch: asJson({
            lines: parsed.lines ?? [],
            validityDays: parsed.validityDays ?? null,
            remarks,
          }),
          before: beforeSnapshot,
          after: afterSnapshot,
          provenance: asJson({
            actorId: ctx.actor.id,
            actorType: ctx.actor.type,
            source: parsed.source,
            instruction: parsed.instruction,
            reasonId: parsed.reasonId ?? null,
            diff,
            requirement,
          }),
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
        })
        .returning();
      const revisionRow = revisionRows[0];
      if (!revisionRow) {
        throw new KernelError("KERNEL_REJECTED", "改稿版本写入未返回记录", {
          reason: "INSERT_RETURNED_NO_ROW",
        });
      }

      const requestRows = await tx
        .insert(revisionRequests)
        .values({
          tenantId: this.tenantId,
          entityType: "quote",
          entityId: row.id,
          source: parsed.source,
          instruction: parsed.instruction,
          patch: asJson({
            lines: parsed.lines ?? [],
            validityDays: parsed.validityDays ?? null,
            remarks,
          }),
          status: "APPROVED",
          reasonId: parsed.reasonId ?? null,
          baseVersion: parsed.baseVersion,
          requestedByType: ctx.actor.type,
          requestedById: ctx.actor.id,
          resolvedBy: ctx.actor.id,
          resolvedAt: new Date(),
        })
        .returning({ id: revisionRequests.id });
      const requestId = requestRows[0]?.id ?? null;

      if (requestId) {
        await tx
          .update(draftRevisions)
          .set({ revisionRequestId: requestId })
          .where(eq(draftRevisions.id, revisionRow.id));
      }

      for (const change of priceChanges) {
        await appendDecisionDeltaWithin(tx, this.tenantId, ctx, {
          customerId: row.customerId,
          entityType: "quote",
          entityId: row.id,
          field: `unit_price_${change.lineIndex}`,
          originalValue: { amount: change.beforeAmount, currency: row.currency },
          modifiedValue: { amount: change.afterAmount, currency: row.currency },
          reasonId: parsed.reasonId ?? null,
          note: parsed.instruction,
        });
      }

      await appendAudit(
        tx,
        ctx,
        {
          action: "REVISION_REQUESTED",
          entityType: "quote",
          entityId: row.id,
          before: { version: row.version, totalAmount: row.totalAmount },
          after: { version: newVersion, totalAmount, source: parsed.source },
        },
        this.tenantId,
      );
      await appendAudit(
        tx,
        ctx,
        {
          action: "QUOTE_DRAFT_REVISED",
          entityType: "quote",
          entityId: row.id,
          before: { version: row.version, totalAmount: row.totalAmount },
          after: {
            version: newVersion,
            totalAmount,
            diffCount: diff.length,
            requiredApprovalRole: requirement.role,
            changePctBps: requirement.changePctBps,
          },
        },
        this.tenantId,
      );
      if (
        requirement.level !== "SALES" &&
        (row.requiredApprovalRole === null ||
          requirement.role !== row.requiredApprovalRole ||
          !row.approvalEscalated)
      ) {
        await appendAudit(
          tx,
          ctx,
          {
            action: "QUOTE_APPROVAL_ESCALATED",
            entityType: "quote",
            entityId: row.id,
            before: {
              requiredApprovalRole: row.requiredApprovalRole,
              escalated: row.approvalEscalated,
            },
            after: {
              requiredApprovalRole: requirement.role,
              reasons: requirement.reasons,
              changePctBps: requirement.changePctBps,
            },
          },
          this.tenantId,
        );
      }

      const freshRow = updatedRows[0] ?? row;
      const finalRow: QuoteRow = {
        ...freshRow,
        requiredApprovalRole: requirement.role,
        approvalEscalated: requirement.escalated,
        escalationReasons: requirement.reasons,
        changePctBps: requirement.changePctBps,
        pendingDiff: asJson(diff),
      };

      return {
        draft: mapQuote(finalRow, lines, requirement),
        revision: mapDraftRevision({ ...revisionRow, revisionRequestId: requestId }),
        diff,
        requirement,
        escalated:
          requirement.level !== "SALES" &&
          (row.requiredApprovalRole === null || requirement.role !== row.requiredApprovalRole),
      };
    });
  }

  /**
   * 确认价格：DRAFT -> SENT。智能体无权确认。
   *
   * D1 已取消审批：这里只校验 `quote.confirm` capability 与确认人审计，
   * `requiredApprovalRole` 不再参与判断（字段保留，P0 不触发）。
   * 非草稿状态若携带同一个幂等键，返回原确认结果，不重复写审计。
   */
  async confirmDraft(
    quoteId: string,
    ctx: KernelContext,
    baseVersion?: number,
    idempotencyKey?: string,
  ): Promise<QuoteConfirmation> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError("PERMISSION_DENIED", "报价确认必须由人类执行，智能体无权确认");
    }
    // 与 assertCanApprove 同一条 fail-closed 纪律：生产态缺角色直接拒绝，
    // 仅本地/测试兼容无角色上下文。
    const role = ctx.actor.role ?? (isProductionLike(process.env) ? undefined : "OWNER");
    if (!role || !hasCapability(role, "quote.confirm")) {
      throw new KernelError(
        "PERMISSION_DENIED",
        `角色 ${role ?? "未知"} 没有确认价格的权限（需要老板/主管）`,
      );
    }
    const confirmedAt = new Date();
    let confirmedVersion = 0;
    // 幂等重放只记事务内读到的确认结果；展示名在事务外统一解析（成员表不在锁里查）。
    // 用 holder 而不是裸变量：赋值发生在事务回调里，TS 的控制流分析看不到，
    // 裸变量会在事务后被收窄成 null。
    const replay: { value: { confirmedBy: string; confirmedAt: string; version: number } | null } =
      { value: null };

    // 「读状态 → 判状态 → 改状态」必须在同一个事务里对同一行加锁完成。
    // 事务外判 DRAFT + UPDATE 只带版本谓词但不自增版本，会让并发两次确认都成功。
    await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(quotes)
        .where(and(eq(quotes.id, quoteId), eq(quotes.tenantId, this.tenantId)))
        .limit(1)
        .for("update");
      const row = locked[0];
      if (!row) {
        throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
          resourceType: "quote",
          resourceId: quoteId,
        });
      }
      // 幂等重放：同一次点击的第二次请求直接返回第一次的结果。
      if (
        row.status === "SENT" &&
        row.confirmedBy !== null &&
        idempotencyKey !== undefined &&
        row.confirmIdempotencyKey === idempotencyKey
      ) {
        replay.value = {
          confirmedBy: row.confirmedBy,
          // confirmedBy 非空即已确认，confirmedAt 由同一事务写入。
          confirmedAt: toIso(row.confirmedAt!),
          // 首次确认返回「被确认的那一版」；确认时版本 +1，所以回放要减回去。
          version: Math.max(1, row.version - 1),
        };
        return;
      }
      if (row.status !== "DRAFT") {
        throw new KernelError("KERNEL_REJECTED", `报价单不是草稿状态：${row.status}`, {
          reason: "INVALID_STATE_TRANSITION",
        });
      }
      if (baseVersion !== undefined && baseVersion !== row.version) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `版本冲突：当前 v${row.version}，审批的是 v${baseVersion}`,
          { reason: "VERSION_CONFLICT" },
        );
      }
      if (row.expiresAt.getTime() <= confirmedAt.getTime()) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `报价已过有效期（${toIso(row.expiresAt)}），不能用过期价格对客户生效`,
          { reason: "QUOTE_EXPIRED" },
        );
      }

      const itemRows = await tx
        .select()
        .from(quoteItems)
        .where(eq(quoteItems.quoteId, quoteId))
        .orderBy(asc(quoteItems.position));
      const lines = itemRows.map((item, index) => lineFromRow(item, index));

      const updated = await tx
        .update(quotes)
        .set({
          status: "SENT",
          confirmedBy: ctx.actor.id,
          confirmedAt,
          confirmIdempotencyKey: idempotencyKey ?? null,
          version: row.version + 1,
          updatedAt: confirmedAt,
        })
        .where(
          and(
            eq(quotes.id, quoteId),
            eq(quotes.tenantId, this.tenantId),
            eq(quotes.status, "DRAFT"),
            eq(quotes.version, row.version),
          ),
        )
        .returning({ id: quotes.id });
      if (!updated[0]) {
        throw new KernelError("KERNEL_REJECTED", "版本冲突：报价已被其他人修改", {
          reason: "VERSION_CONFLICT",
        });
      }
      confirmedVersion = row.version;
      await appendAudit(
        tx,
        ctx,
        {
          action: "QUOTE_CONFIRMED",
          entityType: "quote",
          entityId: quoteId,
          before: {
            status: row.status,
            version: row.version,
            totalAmount: row.totalAmount,
          },
          after: {
            status: "SENT",
            version: row.version + 1,
            confirmedBy: ctx.actor.id,
            idempotencyKey: idempotencyKey ?? null,
            lineCount: lines.length,
          },
        },
        this.tenantId,
      );
    });
    const replayed = replay.value;
    if (replayed) {
      const names = await this.confirmedNames([replayed.confirmedBy]);
      return {
        quoteId,
        status: "SENT",
        ...replayed,
        confirmedByName: names.get(replayed.confirmedBy) ?? null,
      };
    }
    const names = await this.confirmedNames([ctx.actor.id]);
    return {
      quoteId,
      status: "SENT",
      confirmedBy: ctx.actor.id,
      confirmedByName: names.get(ctx.actor.id) ?? null,
      confirmedAt: confirmedAt.toISOString(),
      version: confirmedVersion,
    };
  }

  /** 驳回：结构化原因进 decision_deltas，下次建议更准。 */
  async rejectDraft(
    quoteId: string,
    ctx: KernelContext,
    note?: string,
    reasonId?: string,
  ): Promise<{ status: "REJECTED" }> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "报价驳回必须由人类在审批窗口执行，智能体无权驳回",
      );
    }
    const rejectedAt = new Date();

    // 与 confirm 同一把行锁：确认与驳回是互斥决策，不能都成功、更不能留下矛盾状态行。
    await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(quotes)
        .where(and(eq(quotes.id, quoteId), eq(quotes.tenantId, this.tenantId)))
        .limit(1)
        .for("update");
      const row = locked[0];
      if (!row) {
        throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
          resourceType: "quote",
          resourceId: quoteId,
        });
      }
      if (row.status !== "DRAFT") {
        throw new KernelError("KERNEL_REJECTED", `报价单不是草稿状态：${row.status}`, {
          reason: "INVALID_STATE_TRANSITION",
        });
      }

      const baseline = parseBaseline(row);
      const policies = await resolveApprovalPolicies(this.pricing, {
        customerId: row.customerId,
      });
      const requirement = requirementFromRow(row, policies, baseline?.totalAmount ?? null);
      assertCanApprove(ctx.actor.role, requirement, ctx.actor.approvalLimitAmount);

      const updated = await tx
        .update(quotes)
        .set({ status: "REJECTED", version: row.version + 1, updatedAt: rejectedAt })
        .where(
          and(
            eq(quotes.id, quoteId),
            eq(quotes.tenantId, this.tenantId),
            eq(quotes.status, "DRAFT"),
            eq(quotes.version, row.version),
          ),
        )
        .returning({ id: quotes.id });
      if (!updated[0]) {
        throw new KernelError("KERNEL_REJECTED", "版本冲突：报价已被其他人修改", {
          reason: "VERSION_CONFLICT",
        });
      }
      await appendDecisionDeltaWithin(tx, this.tenantId, ctx, {
        customerId: row.customerId,
        entityType: "quote",
        entityId: quoteId,
        field: "quote_status",
        originalValue: "DRAFT",
        modifiedValue: "REJECTED",
        reasonId: reasonId ?? null,
        note: note ?? null,
      });
      await appendAudit(
        tx,
        ctx,
        {
          action: "QUOTE_REJECTED",
          entityType: "quote",
          entityId: quoteId,
          before: {
            status: row.status,
            version: row.version,
            totalAmount: row.totalAmount,
          },
          after: {
            status: "REJECTED",
            version: row.version + 1,
            rejectedBy: ctx.actor.id,
            note: note ?? null,
            reasonId: reasonId ?? null,
          },
        },
        this.tenantId,
      );
    });
    return { status: "REJECTED" };
  }

  /**
   * 报价工作台列表（WAN-175）：状态 / 关键词 / 客户筛选 + 游标分页。
   *
   * 与 `list()` 的区别：这里给的是「工作台需要的摘要」（客户名、行数、金额、
   * 有效期），不是审批项；明细留给 `GET /api/quotes/:id` 懒加载。
   * 数据范围与筛选同样先于分页在 SQL 里完成，翻页不会忽多忽少。
   */
  async listWorkbench(query: QuoteListFilter, ctx: KernelContext): Promise<QuoteListResponse> {
    if (!ctx.actor.role || !hasCapability(ctx.actor.role, "quote.workbench.view")) {
      throw new KernelError("PERMISSION_DENIED", "当前角色没有报价工作台权限", {
        reason: "QUOTE_WORKBENCH_FORBIDDEN",
      });
    }
    const cursor = parseApprovalCursor(decodeCursor(query.cursor));
    const conditions: SQL[] = [eq(quotes.tenantId, this.tenantId)];
    const scope = ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId);
    if (scope) conditions.push(scope);
    if (query.status) conditions.push(eq(quotes.status, query.status));
    if (query.customerId) conditions.push(eq(quotes.customerId, query.customerId));
    if (query.query) {
      const pattern = `%${query.query.replace(/[%_]/g, (match) => "\\" + match)}%`;
      conditions.push(
        or(
          ilike(customers.name, pattern),
          sql`exists (
            select 1 from quote_items qi
            where qi.quote_id = ${quotes.id}
              and qi.description ilike ${pattern}
          )`,
        )!,
      );
    }
    if (cursor) {
      const at = new Date(cursor.createdAt);
      conditions.push(
        or(lt(quotes.createdAt, at), and(eq(quotes.createdAt, at), lt(quotes.id, cursor.id)))!,
      );
    }

    const rows = await this.db
      .select({ quote: quotes, customerName: customers.name })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(and(...conditions))
      .orderBy(desc(quotes.createdAt), desc(quotes.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const ids = page.map((entry) => entry.quote.id);
    const itemRows =
      ids.length === 0
        ? []
        : await this.db
            .select({ quoteId: quoteItems.quoteId })
            .from(quoteItems)
            .where(inArray(quoteItems.quoteId, ids));
    const countBy = new Map<string, number>();
    for (const item of itemRows) {
      countBy.set(item.quoteId, (countBy.get(item.quoteId) ?? 0) + 1);
    }

    const last = page[page.length - 1]?.quote;
    return QuoteListResponse.parse({
      items: page.map(({ quote, customerName }) => ({
        id: quote.id,
        customerId: quote.customerId,
        customerName,
        status: quote.status,
        currency: currencyOf(quote.currency),
        total: { amount: quote.totalAmount, currency: currencyOf(quote.currency) },
        version: quote.version,
        itemCount: countBy.get(quote.id) ?? 0,
        expiresAt: toIso(quote.expiresAt),
        createdAt: toIso(quote.createdAt),
        updatedAt: toIso(quote.updatedAt),
        pendingApproval: quote.status === "DRAFT",
      })),
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: toIso(last.createdAt), id: last.id }) : null,
    });
  }

  /**
   * 审批队列 / 全景的只读视图：把账本里的报价单映射成 ApprovalItem。
   * 数据范围按客户负责人过滤（报价本身没有归属人列）。
   *
   * 过滤（租户 + 数据范围 + DRAFT）全部在 SQL 里完成，`limit` / `after`
   * 才生效：先过滤再分页，翻页时不会出现条数忽多忽少。
   */
  async list(
    limit = 50,
    ctx?: KernelContext,
    query: ApprovalListQuery = {},
  ): Promise<ApprovalItem[]> {
    const conditions: SQL[] = [eq(quotes.tenantId, this.tenantId)];
    const scope = ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId);
    if (scope) conditions.push(scope);
    if (query.pendingOnly) conditions.push(eq(quotes.status, "DRAFT"));
    conditions.push(...approvalListConditions(quotes.createdAt, quotes.id, query));

    const rows = (
      await this.db
        .select({ quote: quotes })
        .from(quotes)
        .innerJoin(customers, eq(customers.id, quotes.customerId))
        .where(and(...conditions))
        .orderBy(desc(quotes.createdAt), desc(quotes.id))
        .limit(limit)
    ).map((entry) => entry.quote);
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const itemRows = await this.db
      .select({ quoteId: quoteItems.quoteId })
      .from(quoteItems)
      .where(inArray(quoteItems.quoteId, ids));
    const countBy = new Map<string, number>();
    for (const item of itemRows) {
      countBy.set(item.quoteId, (countBy.get(item.quoteId) ?? 0) + 1);
    }

    const policiesByCustomer = new Map<string, Partial<Record<PricingKey, ResolvedPricingValue>>>();
    const items: ApprovalItem[] = [];
    for (const row of rows) {
      let requirement: ApprovalRequirement | null = null;
      if (row.status === "DRAFT") {
        let policies = policiesByCustomer.get(row.customerId);
        if (!policies) {
          policies = await resolveApprovalPolicies(this.pricing, {
            customerId: row.customerId,
          });
          policiesByCustomer.set(row.customerId, policies);
        }
        const baseline = parseBaseline(row);
        requirement = requirementFromRow(row, policies, baseline?.totalAmount ?? null);
      }
      items.push(
        ApprovalItem.parse({
          id: row.id,
          kind: "quote",
          title: `报价单 · ${row.id.slice(0, 8)} · v${row.version}`,
          summary: `${countBy.get(row.id) ?? 0} 行 · ${formatMoney({
            amount: row.totalAmount,
            currency: currencyOf(row.currency),
          })}`,
          status: row.status,
          pending: row.status === "DRAFT",
          amountCents: row.totalAmount,
          currency: currencyOf(row.currency),
          customerId: row.customerId,
          createdAt: toIso(row.createdAt),
          confirmedBy: row.confirmedBy ?? null,
          version: row.version,
          requiredRole: requirement?.role ?? row.requiredApprovalRole ?? null,
          requiredLevel: requirement?.level ?? null,
          escalated: requirement?.escalated ?? row.approvalEscalated,
          escalationReasons: requirement?.reasons ?? row.escalationReasons,
          changePctBps: requirement?.changePctBps ?? row.changePctBps,
          diff: (row.pendingDiff as unknown as RevisionDiff[]) ?? [],
          requirement,
        }),
      );
    }
    return items;
  }

  /**
   * 确认人展示名：`quotes.confirmed_by` 存的是 SSO subject（UUID），
   * 面向用户的读取必须换成成员姓名 / 邮箱（WAN-203）。
   *
   * 一次批量解析，避免列表页按报价逐个查成员表；查不到（历史数据、成员已离职）
   * 返回 null，由前端用「我 / 同事」兜底，绝不回退到 subject。
   */
  private async confirmedNames(subjects: Array<string | null>): Promise<Map<string, string>> {
    const ids = [...new Set(subjects.filter((value): value is string => Boolean(value)))];
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        subject: memberships.subject,
        displayName: memberships.displayName,
        email: memberships.email,
      })
      .from(memberships)
      .where(and(eq(memberships.tenantId, this.tenantId), inArray(memberships.subject, ids)));
    const names = new Map<string, string>();
    for (const row of rows) {
      const name = memberDisplayName(row.displayName, row.email);
      if (name) names.set(row.subject, name);
    }
    return names;
  }

  private async loadQuote(
    quoteId: string,
    ctx?: KernelContext,
  ): Promise<{ row: QuoteRow; lines: CurrentLine[] }> {
    // 报价没有自己的归属人列：归属随客户，越权时按「不存在」返回。
    const rows = await this.db
      .select({ quote: quotes })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(
        and(
          eq(quotes.id, quoteId),
          eq(quotes.tenantId, this.tenantId),
          ownerScopeFilter(this.db, ctx, this.tenantId, customers.ownerId),
        ),
      )
      .limit(1);
    const row = rows[0]?.quote;
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
        resourceType: "quote",
        resourceId: quoteId,
      });
    }
    const itemRows = await this.db
      .select()
      .from(quoteItems)
      .where(eq(quoteItems.quoteId, quoteId))
      .orderBy(asc(quoteItems.position));
    return { row, lines: itemRows.map((item, index) => lineFromRow(item, index)) };
  }
}

function provenanceRecord(value: JsonValue): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function mapDraftRevision(row: DraftRevisionRow): DraftRevision {
  return DraftRevision.parse({
    id: row.id,
    tenantId: row.tenantId,
    revisionRequestId: row.revisionRequestId,
    entityType: row.entityType,
    entityId: row.entityId,
    version: row.version,
    patch: row.patch,
    before: row.before,
    after: row.after,
    provenance: row.provenance,
    actorType: row.actorType,
    actorId: row.actorId,
    createdAt: toIso(row.createdAt),
  });
}

/**
 * 展示用报价编号：`BJ-YYYYMMDD-XXXX`。
 *
 * 报价表没有独立编号列（P0 不新增序列），用创建日期 + id 前缀派生：
 * 同一天内 4 位十六进制足够区分；它只用于人读与复制文本，不是可寻址标识。
 */
export function quoteNumberOf(row: { id: string; createdAt: Date }): string {
  const day = row.createdAt.toISOString().slice(0, 10).replace(/-/g, "");
  return `BJ-${day}-${row.id.slice(0, 4).toUpperCase()}`;
}
