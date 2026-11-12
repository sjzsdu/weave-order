import { draftRevisions, quoteItems, quotes, revisionRequests, samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  ApprovalItem,
  DraftRevision,
  QuoteApprovalView,
  ReviseQuoteDraftInput,
  RevisionDiff,
  T004GenerateQuoteDraftInput,
} from "@weave-order/schema";
import type {
  ApprovalRequirement,
  Currency,
  JsonValue,
  PricingContext,
  PricingKey,
  QuoteConfirmation,
  QuoteDraft,
  QuoteLineItem,
  QuoteRevisionData,
  ResolvedPricingValue,
  Unit,
} from "@weave-order/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { assertCanApprove, computeRequirement, resolveApprovalPolicies } from "./approval-policy";
import { appendDecisionDeltaWithin } from "./decision-delta";
import type { CustomerService } from "./customers.service";
import { KernelError } from "./errors";
import { formatMoney, milliToQuantity, multiplyCents, quantityToMilli } from "./money";
import { currencyOf, toIso } from "./mappers";
import { priceFloorOf } from "./price-rules";
import { numericValue } from "./pricing.service";
import type { PricingService } from "./pricing.service";
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

function requirementFromRow(
  row: QuoteRow,
  policies: Partial<Record<PricingKey, ResolvedPricingValue>>,
  baselineCents: number | null,
): ApprovalRequirement {
  return computeRequirement({
    amountCents: row.totalAmount,
    baselineCents,
    policies,
    numeric: numericValue,
  });
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
    private readonly tenantId: string,
  ) {}

  async generateDraft(input: unknown, ctx: KernelContext): Promise<QuoteDraft> {
    const parsed = T004GenerateQuoteDraftInput.parse(input);
    const customer = await this.customers.getById(parsed.customerId);

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

      const floor = priceFloorOf(
        sample,
        parsed.currency,
        numericValue(minMargin.value) ?? 0,
        numericValue(companyFloor.value) ?? 0,
      );
      if (floor > 0 && item.unitPrice.amount < floor) {
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

  async getDraft(quoteId: string): Promise<QuoteDraft> {
    const { row, lines } = await this.loadQuote(quoteId, true);
    const baseline = parseBaseline(row);
    const policies = await resolveApprovalPolicies(this.pricing, {
      customerId: row.customerId,
    });
    const requirement = requirementFromRow(row, policies, baseline?.totalAmount ?? null);
    return mapQuote(row, lines, requirement);
  }

  /** 审批卡详情：只读，逐行 diff + 每个数字的出处。 */
  async getApprovalView(quoteId: string): Promise<QuoteApprovalView> {
    const { row, lines } = await this.loadQuote(quoteId, false);
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
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "改稿必须由人类确认后执行；智能体只能产出 Patch（G10）",
      );
    }
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
          if (floor > 0 && patch.unitPrice.amount < floor) {
            throw new KernelError(
              "KERNEL_REJECTED",
              `第 ${line.lineIndex + 1} 行单价低于成本底线/最低毛利：${patch.unitPrice.amount} < ${floor}（分）`,
              { reason: "PRICE_BELOW_COST_FLOOR" },
            );
          }
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

      for (const line of lines) {
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

  /** 人类审批窗口确认报价草稿：DRAFT -> SENT。智能体无权确认。 */
  async confirmDraft(
    quoteId: string,
    ctx: KernelContext,
    baseVersion?: number,
  ): Promise<QuoteConfirmation> {
    if (ctx.actor.type !== "HUMAN") {
      throw new KernelError(
        "PERMISSION_DENIED",
        "报价确认必须由人类在审批窗口执行，智能体无权确认",
      );
    }
    const { row, lines } = await this.loadQuote(quoteId, true);
    const baseline = parseBaseline(row);
    const policies = await resolveApprovalPolicies(this.pricing, {
      customerId: row.customerId,
    });
    const requirement = requirementFromRow(row, policies, baseline?.totalAmount ?? null);
    assertCanApprove(ctx.actor.role, requirement);
    if (baseVersion !== undefined && baseVersion !== row.version) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `版本冲突：当前 v${row.version}，审批的是 v${baseVersion}`,
        { reason: "VERSION_CONFLICT" },
      );
    }

    const confirmedAt = new Date();
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(quotes)
        .set({
          status: "SENT",
          confirmedBy: ctx.actor.id,
          confirmedAt,
          updatedAt: confirmedAt,
        })
        .where(
          and(
            eq(quotes.id, quoteId),
            eq(quotes.tenantId, this.tenantId),
            eq(quotes.version, row.version),
          ),
        )
        .returning();
      if (!rows[0]) {
        throw new KernelError("KERNEL_REJECTED", "版本冲突：报价已被其他人修改", {
          reason: "VERSION_CONFLICT",
        });
      }
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
            version: row.version,
            confirmedBy: ctx.actor.id,
            requiredApprovalRole: requirement.role,
            changePctBps: requirement.changePctBps,
            lineCount: lines.length,
          },
        },
        this.tenantId,
      );
    });
    return {
      quoteId,
      status: "SENT",
      confirmedBy: ctx.actor.id,
      confirmedAt: confirmedAt.toISOString(),
      version: row.version,
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
    const { row } = await this.loadQuote(quoteId, true);
    const baseline = parseBaseline(row);
    const policies = await resolveApprovalPolicies(this.pricing, {
      customerId: row.customerId,
    });
    const requirement = requirementFromRow(row, policies, baseline?.totalAmount ?? null);
    assertCanApprove(ctx.actor.role, requirement);
    const rejectedAt = new Date();
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(quotes)
        .set({ status: "REJECTED", updatedAt: rejectedAt })
        .where(
          and(
            eq(quotes.id, quoteId),
            eq(quotes.tenantId, this.tenantId),
            eq(quotes.version, row.version),
          ),
        )
        .returning();
      if (!rows[0]) {
        throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
          resourceType: "quote",
          resourceId: quoteId,
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
            confirmedBy: ctx.actor.id,
            note: note ?? null,
            reasonId: reasonId ?? null,
          },
        },
        this.tenantId,
      );
    });
    return { status: "REJECTED" };
  }

  /** 审批队列 / 全景的只读视图：把账本里的报价单映射成 ApprovalItem。 */
  async list(limit = 50): Promise<ApprovalItem[]> {
    const rows = await this.db
      .select()
      .from(quotes)
      .where(eq(quotes.tenantId, this.tenantId))
      .orderBy(desc(quotes.createdAt))
      .limit(limit);
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

  private async loadQuote(
    quoteId: string,
    requireDraft: boolean,
  ): Promise<{ row: QuoteRow; lines: CurrentLine[] }> {
    const rows = await this.db
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, quoteId), eq(quotes.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
        resourceType: "quote",
        resourceId: quoteId,
      });
    }
    if (requireDraft && row.status !== "DRAFT") {
      throw new KernelError("KERNEL_REJECTED", `报价单不是草稿状态：${row.status}`, {
        reason: "INVALID_STATE_TRANSITION",
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
