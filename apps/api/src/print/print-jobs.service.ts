import {
  boxLabels,
  documentSnapshots,
  orderBoxItems,
  orderBoxes,
  orderItems,
  printJobEvents,
  printJobs,
  printers,
  samples,
  scanEvents,
} from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  CreateBoxesInput,
  CreatePrintJobInput,
  PickScanInput,
  SampleCardPrintInput,
  SampleCardReprintInput,
  PrintAgentJob,
  PrintJobResultInput,
  PrintShipmentBundleInput,
  ScanResult,
  VerifyScanInput,
} from "@weave-order/schema";
import type {
  DocumentView,
  JsonValue,
  OrderBox,
  PrintAgentJob as PrintAgentJobType,
  PrintDocumentKind,
  PrintJob,
  PrintJobList,
  PrintLogEntry,
  PrintTemplateFormat,
  ReprintReason,
  ShipmentView,
  Unit,
} from "@weave-order/schema";
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { appendAudit } from "../kernel/audit";
import type { KernelContext } from "../kernel/audit";
import { KernelError } from "../kernel/errors";
import { milliToQuantity, quantityToMilli } from "../kernel/money";
import { toIso, toIsoOrNull } from "../kernel/mappers";
import { renderBoxLabel, renderTestLabel } from "./labels";
import type { SampleCardService } from "./sample-card.service";
import { assertSampleCardPrintable, sampleCardValues } from "./sample-card";
import { renderA4Pdf } from "./pdf";
import { PrintViewService } from "./print-view.service";
import { buildBoxQr, parseBoxQr } from "./qr";
import { PrintError, renderTemplate, valuesFromDocumentView } from "./template-engine";
import type { ResolvedTemplate } from "./print-templates.service";
import type { PrintTemplateService } from "./print-templates.service";

const A4_KINDS: PrintDocumentKind[] = ["PICKING_LIST", "DELIVERY_NOTE", "PACKING_LIST"];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jobKey(input: {
  kind: PrintDocumentKind;
  documentId: string;
  templateId: string | null;
  versionId: string | null;
  templateName: string;
  copies: number;
  operator: string;
  labelSeq?: number | null;
  /** 补打序号：同一张卡补打必须生成新任务，不能被幂等键吞掉。 */
  attempt?: number;
}): string {
  return hash(
    [
      input.kind,
      input.documentId,
      input.templateId ?? "system",
      input.versionId ?? input.templateName,
      input.copies,
      input.operator,
      input.labelSeq ?? "",
      input.attempt ?? 0,
    ].join("|"),
  );
}

function mapJob(row: typeof printJobs.$inferSelect): PrintJob {
  return {
    id: row.id,
    kind: row.kind,
    documentId: row.documentId,
    orderId: row.orderId,
    shipmentId: row.shipmentId,
    boxId: row.boxId,
    labelSeq: row.labelSeq,
    templateVersion: row.templateVersion,
    format: row.format,
    copies: row.copies,
    priority: row.priority,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    reprintReason: row.reprintReason as PrintJob["reprintReason"],
    requestedBy: row.requestedBy,
    attempts: row.attempts,
    lastError: row.lastError,
    printerId: row.printerId,
    agentId: row.agentId,
    snapshotId: row.snapshotId,
    createdAt: toIso(row.createdAt),
    completedAt: toIsoOrNull(row.completedAt),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (code === "23505") return true;
  const cause = (error as { cause?: unknown }).cause;
  return Boolean(
    cause && typeof cause === "object" && (cause as { code?: string }).code === "23505",
  );
}

function printErrorAsKernel(error: unknown): never {
  if (error instanceof PrintError) {
    const status =
      error.code === "PRINT_TEMPLATE_NOT_FOUND" ? "RESOURCE_NOT_FOUND" : "KERNEL_REJECTED";
    throw new KernelError(status, error.message, { reason: error.code, ...error.detail });
  }
  throw error;
}

export type PrintDispatch = (input: {
  tenantId: string;
  agentId: string | null;
  job: PrintAgentJobType;
}) => void;

export class PrintJobService {
  private dispatch: PrintDispatch | null = null;

  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly views: PrintViewService,
    private readonly templates: PrintTemplateService,
    private readonly sampleCards: SampleCardService,
  ) {}

  setDispatcher(dispatch: PrintDispatch): void {
    this.dispatch = dispatch;
  }

  private async printerFor(
    printerId: string | null | undefined,
  ): Promise<typeof printers.$inferSelect | null> {
    if (!printerId) return null;
    const rows = await this.db
      .select()
      .from(printers)
      .where(and(eq(printers.id, printerId), eq(printers.tenantId, this.tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private formatFor(
    kind: PrintDocumentKind,
    printer: typeof printers.$inferSelect | null,
  ): PrintTemplateFormat {
    if (A4_KINDS.includes(kind)) return "HTML";
    if (printer?.kind === "BLUETOOTH") return "TSPL";
    if (printer) {
      const capabilities = printer.capabilities as { format?: unknown } | null;
      if (capabilities?.format === "TSPL") return "TSPL";
      return "ZPL";
    }
    return "ZPL";
  }

  private async createSnapshot(input: {
    kind: PrintDocumentKind;
    documentId: string;
    view: unknown;
    operator: string;
  }): Promise<string> {
    const viewJson = JSON.parse(JSON.stringify(input.view)) as JsonValue;
    const rows = await this.db
      .insert(documentSnapshots)
      .values({
        tenantId: this.tenantId,
        kind: input.kind,
        documentId: input.documentId,
        view: viewJson,
        sha256: hash(JSON.stringify(viewJson)),
        createdBy: input.operator,
      })
      .returning();
    return rows[0]!.id;
  }

  /** 单张单据打印：幂等键命中时返回原任务，不重复出纸。 */
  async enqueue(
    input: unknown,
    ctx: KernelContext,
  ): Promise<{ job: PrintJob; deduplicated: boolean }> {
    const parsed = CreatePrintJobInput.parse(input);
    if (parsed.kind === "SAMPLE_LABEL") {
      if (!parsed.quoteId) {
        throw new KernelError("KERNEL_REJECTED", "样卡必须以已确认报价为单据（缺少 quoteId）", {
          reason: "INVALID_INPUT",
        });
      }
      return this.createSampleCardJob(
        {
          quoteId: parsed.quoteId,
          lineIndex: parsed.lineIndex,
          format: parsed.format ?? "HTML",
          copies: parsed.copies,
          priority: parsed.priority,
          printerId: parsed.printerId ?? null,
          templateId: parsed.templateId ?? null,
          reprintReason: parsed.reprintReason ?? null,
          operator: ctx.actor.id,
          attempt: 0,
        },
        ctx,
      );
    }
    if (
      parsed.kind === "SHELF_LABEL" ||
      (parsed.kind !== "BOX_LABEL" && parsed.kind !== "TEST_LABEL" && !parsed.shipmentId)
    ) {
      throw new KernelError("KERNEL_REJECTED", `暂不支持单独打印：${parsed.kind}`);
    }
    let shipmentId = parsed.shipmentId;
    const boxId = parsed.boxId ?? null;
    if (parsed.kind === "BOX_LABEL") {
      if (!boxId) {
        throw new KernelError("KERNEL_REJECTED", "箱唛必须指定 boxId", {
          reason: "INVALID_INPUT",
        });
      }
      const boxRows = await this.db
        .select()
        .from(orderBoxes)
        .where(and(eq(orderBoxes.id, boxId), eq(orderBoxes.tenantId, this.tenantId)))
        .limit(1);
      const box = boxRows[0];
      if (!box) throw new KernelError("RESOURCE_NOT_FOUND", `箱不存在：${boxId}`);
      shipmentId = box.shipmentId;
    }
    if (!shipmentId) {
      throw new KernelError("KERNEL_REJECTED", "缺少 shipmentId", { reason: "INVALID_INPUT" });
    }

    const shipmentView = await this.views.getShipmentView(shipmentId);
    this.assertPrintable(shipmentView, parsed.kind);
    const box = boxId ? shipmentView.boxes.find((item) => item.id === boxId) : undefined;
    if (parsed.kind === "BOX_LABEL" && !box) {
      throw new KernelError("RESOURCE_NOT_FOUND", `箱不属于该发货单：${boxId}`);
    }

    const printer = await this.printerFor(parsed.printerId);
    const format = this.formatFor(parsed.kind, printer);
    let resolved: ResolvedTemplate;
    try {
      resolved = await this.templates.resolve({
        kind: parsed.kind,
        format,
        templateId: parsed.templateId,
      });
    } catch (error) {
      printErrorAsKernel(error);
    }
    const documentId = box?.id ?? shipmentId;
    const view = await this.views.buildDocumentView({
      kind: parsed.kind,
      shipmentId,
      ...(boxId ? { boxId } : {}),
      operator: ctx.actor.id,
      ...(parsed.reprintReason ? { reprintReason: parsed.reprintReason } : {}),
    });
    const key = jobKey({
      kind: parsed.kind,
      documentId,
      templateId: resolved.templateId,
      versionId: resolved.versionId,
      templateName: resolved.name,
      copies: parsed.copies,
      operator: ctx.actor.id,
      labelSeq: box?.seq ?? null,
    });

    const existing = await this.db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.tenantId, this.tenantId), eq(printJobs.idempotencyKey, key)))
      .limit(1);
    if (existing[0]) return { job: mapJob(existing[0]), deduplicated: true };

    // 幂等命中在渲染之前返回：重复点击不会重新生成 PDF，也不会重复出纸。
    const payload = await this.renderPayload({
      kind: parsed.kind,
      view,
      box,
      resolved,
      format,
      reprintReason: parsed.reprintReason ?? null,
    });

    let jobRow: typeof printJobs.$inferSelect | undefined;
    try {
      const snapshotId = await this.createSnapshot({
        kind: parsed.kind,
        documentId,
        view,
        operator: ctx.actor.id,
      });
      jobRow = await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(printJobs)
          .values({
            tenantId: this.tenantId,
            kind: parsed.kind,
            documentId,
            orderId: shipmentView.orderId,
            shipmentId,
            boxId,
            labelSeq: box?.seq ?? null,
            templateId: resolved.templateId,
            templateVersionId: resolved.versionId,
            templateVersion: resolved.version,
            printerId: printer?.id ?? null,
            agentId: printer?.agentId ?? null,
            format,
            copies: parsed.copies,
            priority: parsed.priority,
            status: "QUEUED",
            idempotencyKey: key,
            payload,
            snapshotId,
            reprintReason: parsed.reprintReason ?? null,
            requestedBy: ctx.actor.id,
          })
          .returning();
        const row = rows[0]!;
        await tx.insert(printJobEvents).values({
          tenantId: this.tenantId,
          jobId: row.id,
          status: "QUEUED",
          message: `已入队：${parsed.copies} 份`,
          printerId: printer?.id ?? null,
        });
        await appendAudit(
          tx,
          ctx,
          {
            action: "PRINT_JOB_CREATED",
            entityType: "print_job",
            entityId: row.id,
            before: null,
            after: {
              kind: row.kind,
              documentId: row.documentId,
              copies: row.copies,
              templateVersion: row.templateVersion,
            },
          },
          this.tenantId,
        );
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const rows = await this.db
          .select()
          .from(printJobs)
          .where(and(eq(printJobs.tenantId, this.tenantId), eq(printJobs.idempotencyKey, key)))
          .limit(1);
        if (rows[0]) return { job: mapJob(rows[0]), deduplicated: true };
      }
      throw error;
    }

    const job = mapJob(jobRow);
    await this.dispatchJob(job, printer);
    return { job, deduplicated: false };
  }

  /**
   * 样卡任务：单据是报价，一张价对应一行样品。
   *
   * 幂等键 = 单据 + 模板版本 + 份数 + 操作人（外加样卡序号与补打序号）：
   * 同一个操作人重复点「打印」不会多出纸，换了操作人或换了模板才生成新任务。
   * 打印不创建、也不修改样品——它只读报价与样品。
   */
  private async createSampleCardJob(
    input: {
      quoteId: string;
      lineIndex: number;
      format: PrintTemplateFormat;
      copies: number;
      priority: number;
      printerId: string | null;
      templateId: string | null;
      reprintReason: ReprintReason | null;
      operator: string;
      attempt: number;
    },
    ctx: KernelContext,
  ): Promise<{ job: PrintJob; deduplicated: boolean }> {
    const printer = await this.printerFor(input.printerId);
    let resolved: ResolvedTemplate;
    try {
      resolved = await this.templates.resolve({
        kind: "SAMPLE_LABEL",
        format: input.format,
        ...(input.templateId ? { templateId: input.templateId } : {}),
      });
    } catch (error) {
      printErrorAsKernel(error);
    }

    const source = await this.sampleCards.buildSource({
      quoteId: input.quoteId,
      lineIndex: input.lineIndex,
      operator: input.operator,
      reprintReason: input.reprintReason,
    });
    const values = sampleCardValues(source);
    assertSampleCardPrintable(values);

    const labelSeq = input.lineIndex + 1;
    const key = jobKey({
      kind: "SAMPLE_LABEL",
      documentId: input.quoteId,
      templateId: resolved.templateId,
      versionId: resolved.versionId,
      templateName: resolved.name,
      copies: input.copies,
      operator: input.operator,
      labelSeq,
      attempt: input.attempt,
    });

    const existing = await this.db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.tenantId, this.tenantId), eq(printJobs.idempotencyKey, key)))
      .limit(1);
    if (existing[0]) return { job: mapJob(existing[0]), deduplicated: true };

    const rendered = await this.sampleCards.render({
      source,
      values,
      resolved,
      format: input.format,
    });
    const payload = input.format === "HTML" ? rendered.pdfBase64 : rendered.text;
    if (!payload) {
      throw new PrintError("PRINT_MISSING_FIELD", "样卡渲染没有产出可打印的内容");
    }

    let jobRow: typeof printJobs.$inferSelect | undefined;
    try {
      const snapshotId = await this.createSnapshot({
        kind: "SAMPLE_LABEL",
        documentId: input.quoteId,
        view: {
          quoteNo: source.quoteNo,
          lineIndex: input.lineIndex,
          sample: source.sample,
          tenant: source.tenant,
          salesperson: source.salesperson,
          qrPayload: source.qrPayload,
          format: input.format,
          pageSize: resolved.pageSize,
          templateName: resolved.name,
          printedAt: source.printedAt,
          operator: source.operator,
          reprintReason: source.reprintReason,
        },
        operator: input.operator,
      });
      jobRow = await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(printJobs)
          .values({
            tenantId: this.tenantId,
            kind: "SAMPLE_LABEL",
            documentId: input.quoteId,
            boxId: null,
            labelSeq,
            templateId: resolved.templateId,
            templateVersionId: resolved.versionId,
            templateVersion: resolved.version,
            printerId: printer?.id ?? null,
            agentId: printer?.agentId ?? null,
            format: input.format,
            copies: input.copies,
            priority: input.priority,
            status: "QUEUED",
            idempotencyKey: key,
            payload,
            snapshotId,
            reprintReason: input.reprintReason,
            requestedBy: input.operator,
          })
          .returning();
        const row = rows[0]!;
        await tx.insert(printJobEvents).values({
          tenantId: this.tenantId,
          jobId: row.id,
          status: "QUEUED",
          message: input.reprintReason
            ? `补打样卡 ${source.sample.code}（${input.reprintReason}）`
            : `已入队：样卡 ${source.sample.code} × ${input.copies}`,
          printerId: printer?.id ?? null,
        });
        await appendAudit(
          tx,
          ctx,
          {
            action: input.reprintReason ? "PRINT_SAMPLE_CARD_REPRINTED" : "PRINT_JOB_CREATED",
            entityType: "print_job",
            entityId: row.id,
            before: null,
            after: {
              kind: row.kind,
              quoteId: input.quoteId,
              sampleCode: source.sample.code,
              lineIndex: input.lineIndex,
              copies: row.copies,
              templateVersion: row.templateVersion,
              reprintReason: input.reprintReason,
            },
          },
          this.tenantId,
        );
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const rows = await this.db
          .select()
          .from(printJobs)
          .where(and(eq(printJobs.tenantId, this.tenantId), eq(printJobs.idempotencyKey, key)))
          .limit(1);
        if (rows[0]) return { job: mapJob(rows[0]), deduplicated: true };
      }
      throw error;
    }

    const job = mapJob(jobRow);
    await this.dispatchJob(job, printer);
    return { job, deduplicated: false };
  }

  /** 一份报价一键打全部样卡：每行样品一张，各自幂等。 */
  async printSampleCards(quoteId: string, input: unknown, ctx: KernelContext) {
    const parsed = SampleCardPrintInput.parse(input ?? {});
    const lineCount = await this.sampleCards.lineCount(quoteId);
    if (lineCount === 0) {
      throw new KernelError("KERNEL_REJECTED", "这份报价没有样品行，无法生成样卡", {
        reason: "INVALID_INPUT",
      });
    }
    const jobs: PrintJob[] = [];
    const deduplicated: string[] = [];
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
      const result = await this.createSampleCardJob(
        {
          quoteId,
          lineIndex,
          format: parsed.format,
          copies: parsed.copies,
          priority: 0,
          printerId: parsed.printerId ?? null,
          templateId: parsed.templateId ?? null,
          reprintReason: null,
          operator: ctx.actor.id,
          attempt: 0,
        },
        ctx,
      );
      jobs.push(result.job);
      if (result.deduplicated) deduplicated.push(result.job.id);
    }
    return { jobs, deduplicated };
  }

  /**
   * 补打：必须选原因。不新建样品，只多一条打印任务；
   * 每补一次 `attempt` +1，幂等键随之变化，因此不会被上一次的成功任务吞掉。
   */
  async reprintSampleCard(quoteId: string, input: unknown, ctx: KernelContext) {
    const parsed = SampleCardReprintInput.parse(input);
    const labelSeq = parsed.lineIndex + 1;
    const previous = await this.db
      .select({ id: printJobs.id })
      .from(printJobs)
      .where(
        and(
          eq(printJobs.tenantId, this.tenantId),
          eq(printJobs.kind, "SAMPLE_LABEL"),
          eq(printJobs.documentId, quoteId),
          eq(printJobs.labelSeq, labelSeq),
        ),
      );
    if (previous.length === 0) {
      throw new KernelError("KERNEL_REJECTED", "这张样卡还没有打印过，请先打印", {
        reason: "INVALID_INPUT",
      });
    }
    return this.createSampleCardJob(
      {
        quoteId,
        lineIndex: parsed.lineIndex,
        format: parsed.format,
        copies: parsed.copies,
        priority: 0,
        printerId: parsed.printerId ?? null,
        templateId: null,
        reprintReason: parsed.reason,
        operator: ctx.actor.id,
        attempt: previous.length,
      },
      ctx,
    );
  }

  /** 一份报价的打印记录：打印抽屉据此展示状态与「补打」入口。 */
  async listForQuote(quoteId: string): Promise<PrintJob[]> {
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(
        and(
          eq(printJobs.tenantId, this.tenantId),
          eq(printJobs.kind, "SAMPLE_LABEL"),
          eq(printJobs.documentId, quoteId),
        ),
      )
      .orderBy(desc(printJobs.createdAt));
    return rows.map((row) => mapJob(row));
  }

  async get(jobId: string): Promise<PrintJob> {
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.id, jobId), eq(printJobs.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new KernelError("RESOURCE_NOT_FOUND", `打印任务不存在：${jobId}`);
    return mapJob(row);
  }

  private assertPrintable(view: ShipmentView, kind: PrintDocumentKind): void {
    if (view.printBlockedReason === "DISCREPANCY") {
      throw new KernelError("KERNEL_REJECTED", "箱唛与明细不一致：请先核对差异，再打印", {
        reason: "PRINT_DISCREPANCY_UNRESOLVED",
      });
    }
    if (
      (kind === "BOX_LABEL" || kind === "DELIVERY_NOTE") &&
      view.printBlockedReason === "NO_BOXES"
    ) {
      throw new KernelError("KERNEL_REJECTED", "发货单还没有箱号：请先生成箱号", {
        reason: "PRINT_QUANTITY_MISMATCH",
      });
    }
    if (
      (kind === "BOX_LABEL" || kind === "DELIVERY_NOTE") &&
      view.printBlockedReason === "QUANTITY_MISMATCH"
    ) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `箱内数量 ${view.boxQuantity} 与发货数量 ${view.totalQuantity} 不一致：请先核对差异`,
        { reason: "PRINT_QUANTITY_MISMATCH" },
      );
    }
  }

  private async renderPayload(input: {
    kind: PrintDocumentKind;
    view: DocumentView;
    box?: OrderBox;
    resolved: ResolvedTemplate;
    format: PrintTemplateFormat;
    reprintReason: ReprintReason | null;
  }): Promise<string> {
    try {
      if (input.format === "HTML") {
        const values = valuesFromDocumentView(input.view);
        const html = renderTemplate(input.resolved.body, input.kind, values, {
          format: "HTML",
        });
        const pdf = await renderA4Pdf(input.view, html);
        return pdf.toString("base64");
      }
      if (input.kind === "BOX_LABEL") {
        if (!input.box) throw new PrintError("PRINT_MISSING_FIELD", "箱唛缺少箱");
        return renderBoxLabel({
          view: input.view,
          box: input.box,
          body: input.resolved.body,
          format: input.format,
          reprintReason: input.reprintReason,
        });
      }
      return renderTestLabel({
        view: input.view,
        format: input.format,
        body: input.resolved.body,
      });
    } catch (error) {
      printErrorAsKernel(error);
    }
  }

  /** 一单发货：拣货单 + 箱唛 × 箱数 + 发货单，全部走同一幂等队列。 */
  async enqueueBundle(input: unknown, ctx: KernelContext) {
    const parsed = PrintShipmentBundleInput.parse(input);
    const view = await this.views.getShipmentView(parsed.shipmentId);
    if (view.printBlockedReason === "DISCREPANCY") {
      throw new KernelError("KERNEL_REJECTED", "箱唛与明细不一致：先核对差异", {
        reason: "PRINT_DISCREPANCY_UNRESOLVED",
      });
    }
    if (view.boxes.length === 0) {
      throw new KernelError("KERNEL_REJECTED", "还没有箱号：请先生成箱唛", {
        reason: "PRINT_QUANTITY_MISMATCH",
      });
    }
    if (view.printBlockedReason === "QUANTITY_MISMATCH") {
      throw new KernelError(
        "KERNEL_REJECTED",
        `箱内数量 ${view.boxQuantity} 与发货数量 ${view.totalQuantity} 不一致：先核对差异`,
        { reason: "PRINT_QUANTITY_MISMATCH" },
      );
    }
    const jobs: PrintJob[] = [];
    const deduplicated: string[] = [];
    const run = async (body: unknown) => {
      const result = await this.enqueue(body, ctx);
      jobs.push(result.job);
      if (result.deduplicated) deduplicated.push(result.job.id);
    };
    if (parsed.pickingListCopies > 0) {
      await run({
        kind: "PICKING_LIST",
        shipmentId: parsed.shipmentId,
        copies: parsed.pickingListCopies,
        priority: parsed.priority,
        ...(parsed.printerId ? { printerId: parsed.printerId } : {}),
      });
    }
    if (parsed.deliveryNoteCopies > 0) {
      await run({
        kind: "DELIVERY_NOTE",
        shipmentId: parsed.shipmentId,
        copies: parsed.deliveryNoteCopies,
        priority: parsed.priority,
        ...(parsed.printerId ? { printerId: parsed.printerId } : {}),
      });
    }
    if (parsed.boxLabelCopies > 0) {
      for (const box of view.boxes) {
        await run({
          kind: "BOX_LABEL",
          shipmentId: parsed.shipmentId,
          boxId: box.id,
          copies: parsed.boxLabelCopies,
          priority: parsed.priority + 1,
          ...(parsed.labelPrinterId ? { printerId: parsed.labelPrinterId } : {}),
        });
      }
    }
    return { jobs, deduplicated };
  }

  async list(input: { status?: string; limit?: number } = {}): Promise<PrintJobList> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(
        and(
          eq(printJobs.tenantId, this.tenantId),
          ...(input.status ? [eq(printJobs.status, input.status as never)] : []),
        ),
      )
      .orderBy(desc(printJobs.createdAt))
      .limit(limit);
    const counts = await this.db
      .select({ status: printJobs.status, count: sql<number>`count(*)::int` })
      .from(printJobs)
      .where(eq(printJobs.tenantId, this.tenantId))
      .groupBy(printJobs.status);
    const countOf = (status: string) => counts.find((row) => row.status === status)?.count ?? 0;
    return {
      jobs: rows.map((row) => mapJob(row)),
      counts: {
        queued: countOf("QUEUED") + countOf("SENT") + countOf("PRINTING"),
        failed: countOf("FAILED"),
        done: countOf("DONE"),
      },
    };
  }

  async logs(limit = 50): Promise<PrintLogEntry[]> {
    const rows = await this.db
      .select({ job: printJobs, boxNo: orderBoxes.boxNo })
      .from(printJobs)
      .leftJoin(orderBoxes, eq(orderBoxes.id, printJobs.boxId))
      .where(eq(printJobs.tenantId, this.tenantId))
      .orderBy(desc(printJobs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map(({ job, boxNo }) => ({
      id: job.id,
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      copies: job.copies,
      documentId: job.documentId,
      boxNo,
      requestedBy: job.requestedBy,
      reprintReason: job.reprintReason as PrintLogEntry["reprintReason"],
      message: job.lastError,
      createdAt: toIso(job.createdAt),
    }));
  }

  async cancel(jobId: string, ctx: KernelContext): Promise<PrintJob> {
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.id, jobId), eq(printJobs.tenantId, this.tenantId)))
      .limit(1);
    const job = rows[0];
    if (!job) throw new KernelError("RESOURCE_NOT_FOUND", `打印任务不存在：${jobId}`);
    if (job.status !== "QUEUED" && job.status !== "SENT") {
      throw new KernelError("KERNEL_REJECTED", `任务状态不允许取消：${job.status}`);
    }
    const updated = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(printJobs)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(printJobs.id, jobId))
        .returning();
      await tx.insert(printJobEvents).values({
        tenantId: this.tenantId,
        jobId,
        status: "CANCELLED",
        message: "人工取消",
      });
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_JOB_CANCELLED",
          entityType: "print_job",
          entityId: jobId,
          before: { status: job.status },
          after: { status: "CANCELLED" },
        },
        this.tenantId,
      );
      return result[0]!;
    });
    return mapJob(updated);
  }

  async retry(jobId: string, ctx: KernelContext): Promise<PrintJob> {
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.id, jobId), eq(printJobs.tenantId, this.tenantId)))
      .limit(1);
    const job = rows[0];
    if (!job) throw new KernelError("RESOURCE_NOT_FOUND", `打印任务不存在：${jobId}`);
    if (job.status !== "FAILED" && job.status !== "CANCELLED") {
      throw new KernelError("KERNEL_REJECTED", `只有失败/已取消任务可以重试：${job.status}`);
    }
    const updated = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(printJobs)
        .set({
          status: "QUEUED",
          lastError: null,
          agentId: null,
          claimedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(printJobs.id, jobId))
        .returning();
      await tx.insert(printJobEvents).values({
        tenantId: this.tenantId,
        jobId,
        status: "QUEUED",
        message: "人工重试",
      });
      return result[0]!;
    });
    const mapped = mapJob(updated);
    const printer = updated.printerId ? await this.printerFor(updated.printerId) : null;
    await this.dispatchJob(mapped, printer);
    void ctx;
    return mapped;
  }

  private async dispatchJob(
    job: PrintJob,
    printer: typeof printers.$inferSelect | null,
  ): Promise<void> {
    if (!this.dispatch) return;
    const payload = await this.db
      .select({ payload: printJobs.payload })
      .from(printJobs)
      .where(eq(printJobs.id, job.id))
      .limit(1);
    const agentJob = PrintAgentJob.parse({
      id: job.id,
      kind: job.kind,
      format: job.format,
      copies: job.copies,
      payload: payload[0]?.payload ?? "",
      printerId: printer?.id ?? null,
      printerName: printer?.name ?? null,
      printerKind: printer?.kind ?? null,
      claimedAt: new Date().toISOString(),
    });
    this.dispatch({ tenantId: this.tenantId, agentId: printer?.agentId ?? null, job: agentJob });
  }

  /** Agent 领任务：SKIP LOCKED 保证多台代理不会抢到同一张。 */
  async claim(agentId: string, limit = 5): Promise<PrintAgentJobType[]> {
    const result = await this.db.execute<typeof printJobs.$inferSelect>(sql`
      WITH picked AS (
        SELECT id FROM print_jobs
        WHERE tenant_id = ${this.tenantId}
          AND status = 'QUEUED'
          AND (agent_id IS NULL OR agent_id = ${agentId})
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE print_jobs SET
        status = 'SENT',
        agent_id = ${agentId},
        claimed_at = now(),
        attempts = attempts + 1,
        updated_at = now()
      WHERE id IN (SELECT id FROM picked)
      RETURNING *;
    `);
    const rows = result.rows;
    if (rows.length === 0) return [];
    const printerRows = await this.db
      .select()
      .from(printers)
      .where(and(eq(printers.agentId, agentId), eq(printers.tenantId, this.tenantId)));
    const printersById = new Map(printerRows.map((row) => [row.id, row]));
    const jobs: PrintAgentJobType[] = [];
    for (const row of rows) {
      const preferred = row.printerId ? printersById.get(row.printerId) : undefined;
      const fallback = printerRows.find((printer) =>
        row.format === "HTML" ? printer.kind === "A4" : printer.kind !== "A4",
      );
      const printer = preferred ?? fallback ?? null;
      await this.db.insert(printJobEvents).values({
        tenantId: this.tenantId,
        jobId: row.id,
        status: "SENT",
        message: `已下发给代理`,
        agentId,
        printerId: printer?.id ?? null,
      });
      jobs.push(
        PrintAgentJob.parse({
          id: row.id,
          kind: row.kind,
          format: row.format,
          copies: row.copies,
          payload: row.payload,
          printerId: printer?.id ?? null,
          printerName: printer?.name ?? null,
          printerKind: printer?.kind ?? null,
          claimedAt: new Date().toISOString(),
        }),
      );
    }
    return jobs;
  }

  async report(agentId: string, input: unknown): Promise<PrintJob> {
    const parsed = PrintJobResultInput.parse(input);
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.id, parsed.jobId), eq(printJobs.tenantId, this.tenantId)))
      .limit(1);
    const job = rows[0];
    if (!job) throw new KernelError("RESOURCE_NOT_FOUND", `打印任务不存在：${parsed.jobId}`);
    if (job.agentId && job.agentId !== agentId) {
      throw new PrintError("PRINT_AGENT_UNAUTHORIZED", "任务属于另一台打印代理");
    }
    if (job.status === "DONE" || job.status === "FAILED") {
      return mapJob(job);
    }
    const now = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(printJobs)
        .set({
          status: parsed.status,
          lastError: parsed.status === "FAILED" ? (parsed.message ?? "打印失败") : null,
          printerId: parsed.printerId ?? job.printerId,
          completedAt: parsed.status === "DONE" ? now : null,
          updatedAt: now,
        })
        .where(eq(printJobs.id, job.id))
        .returning();
      await tx.insert(printJobEvents).values({
        tenantId: this.tenantId,
        jobId: job.id,
        status: parsed.status,
        message: parsed.message ?? null,
        agentId,
        printerId: parsed.printerId ?? job.printerId,
      });
      if (parsed.status === "DONE" || parsed.status === "FAILED") {
        await appendAudit(
          tx,
          { actor: { type: "SYSTEM", id: `print-agent:${agentId}` } },
          {
            action: parsed.status === "DONE" ? "PRINT_JOB_COMPLETED" : "PRINT_JOB_FAILED",
            entityType: "print_job",
            entityId: job.id,
            before: { status: job.status },
            after: {
              status: parsed.status,
              message: parsed.message ?? null,
              printerId: parsed.printerId ?? job.printerId,
            },
          },
          this.tenantId,
        );
      }
      return result[0]!;
    });
    return mapJob(updated);
  }

  /** 建箱：默认把实发明细均分到 N 箱，一箱一码；箱与标签都必须留痕。 */
  async createBoxes(input: unknown, ctx: KernelContext) {
    const parsed = CreateBoxesInput.parse(input);
    const view = await this.views.getShipmentView(parsed.shipmentId);
    if (view.boxes.length > 0) {
      throw new KernelError("KERNEL_REJECTED", "该发货单已有箱号，请先作废旧箱再重建");
    }
    const shipmentItemIds = new Set(view.items.map((item) => item.shipmentItemId));
    const plans: Array<{
      boxNo: string;
      grossWeightKg: string | null;
      size: string | null;
      items: Array<{
        shipmentItemId: string;
        orderItemId: string;
        quantityMilli: number;
        unit: Unit;
      }>;
    }> = [];

    if (parsed.autoAssign) {
      for (let index = 0; index < parsed.count; index += 1) {
        plans.push({
          boxNo: `BOX-${String(index + 1).padStart(2, "0")}`,
          grossWeightKg: null,
          size: null,
          items: [],
        });
      }
      for (const item of view.items) {
        const totalMilli = quantityToMilli(item.quantity);
        const base = Math.floor(totalMilli / parsed.count);
        const remainder = totalMilli - base * parsed.count;
        for (let index = 0; index < parsed.count; index += 1) {
          const quantityMilli = base + (index < remainder ? 1 : 0);
          if (quantityMilli <= 0) continue;
          plans[index]!.items.push({
            shipmentItemId: item.shipmentItemId,
            orderItemId: item.orderItemId,
            quantityMilli,
            unit: item.unit,
          });
        }
      }
    } else {
      if (!parsed.boxes || parsed.boxes.length === 0) {
        throw new KernelError("KERNEL_REJECTED", "关闭自动分配时必须提供每箱明细", {
          reason: "INVALID_INPUT",
        });
      }
      const used = new Map<string, number>();
      for (const box of parsed.boxes) {
        const items = box.items.map((item) => {
          const shipmentItem = view.items.find(
            (candidate) => candidate.shipmentItemId === item.shipmentItemId,
          );
          if (!shipmentItem) {
            throw new KernelError("RESOURCE_NOT_FOUND", `发货明细不存在：${item.shipmentItemId}`);
          }
          const quantityMilli = quantityToMilli(item.quantity);
          used.set(item.shipmentItemId, (used.get(item.shipmentItemId) ?? 0) + quantityMilli);
          return {
            shipmentItemId: item.shipmentItemId,
            orderItemId: shipmentItem.orderItemId,
            quantityMilli,
            unit: shipmentItem.unit,
          };
        });
        plans.push({
          boxNo: box.boxNo,
          grossWeightKg: box.grossWeightKg ?? null,
          size: box.size ?? null,
          items,
        });
      }
      for (const item of view.items) {
        const expected = quantityToMilli(item.quantity);
        if ((used.get(item.shipmentItemId) ?? 0) !== expected) {
          throw new KernelError(
            "KERNEL_REJECTED",
            `箱内数量与发货数量不一致：${item.description} 应有 ${item.quantity}，实分 ${milliToQuantity(used.get(item.shipmentItemId) ?? 0)}`,
            { reason: "PRINT_QUANTITY_MISMATCH" },
          );
        }
      }
    }

    const created = await this.db.transaction(async (tx) => {
      const boxes: OrderBox[] = [];
      for (const plan of plans) {
        const boxRows = await tx
          .insert(orderBoxes)
          .values({
            tenantId: this.tenantId,
            shipmentId: parsed.shipmentId,
            orderId: view.orderId,
            boxNo: plan.boxNo,
            seq: 1,
            status: "OPEN",
            grossWeightKg: plan.grossWeightKg,
            size: plan.size,
          })
          .returning();
        const box = boxRows[0]!;
        if (plan.items.length > 0) {
          await tx.insert(orderBoxItems).values(
            plan.items.map((item) => ({
              tenantId: this.tenantId,
              boxId: box.id,
              shipmentItemId: item.shipmentItemId,
              orderItemId: item.orderItemId,
              quantityMilli: item.quantityMilli,
              unit: item.unit,
            })),
          );
        }
        const qr = buildBoxQr({
          tenantId: this.tenantId,
          orderId: view.orderId,
          boxNo: plan.boxNo,
          seq: 1,
        });
        await tx.insert(boxLabels).values({
          tenantId: this.tenantId,
          boxId: box.id,
          seq: 1,
          qrPayload: qr,
          status: "ACTIVE",
        });
        await appendAudit(
          tx,
          ctx,
          {
            action: "PRINT_BOX_CREATED",
            entityType: "order_box",
            entityId: box.id,
            before: null,
            after: { boxNo: plan.boxNo, qr, itemCount: plan.items.length },
          },
          this.tenantId,
        );
        boxes.push({
          id: box.id,
          shipmentId: box.shipmentId,
          boxNo: box.boxNo,
          seq: box.seq,
          qr,
          status: box.status,
          quantity: milliToQuantity(plan.items.reduce((sum, item) => sum + item.quantityMilli, 0)),
          items: plan.items.map((item) => {
            const shipmentItem = view.items.find(
              (candidate) => candidate.shipmentItemId === item.shipmentItemId,
            )!;
            return {
              shipmentItemId: item.shipmentItemId,
              orderItemId: item.orderItemId,
              description: shipmentItem.description,
              quantity: milliToQuantity(item.quantityMilli),
              unit: item.unit,
            };
          }),
          grossWeightKg: plan.grossWeightKg,
          size: plan.size,
          note: null,
          hasDiscrepancy: false,
          verifiedAt: null,
          printedAt: null,
          printCount: 0,
          createdAt: toIso(box.createdAt),
        });
      }
      return boxes;
    });
    void shipmentItemIds;
    return { boxes: created, shipment: await this.views.getShipmentView(parsed.shipmentId) };
  }

  /** 补打：必须选原因；旧标签作废留 voided_at，新标签 seq+1。 */
  async reprintBox(
    boxId: string,
    input: { reason: ReprintReason; copies?: number; printerId?: string | null },
    ctx: KernelContext,
  ) {
    if (!input.reason) {
      throw new KernelError("KERNEL_REJECTED", "补打箱唛必须选择原因", {
        reason: "PRINT_REPRINT_REASON_REQUIRED",
      });
    }
    const boxRows = await this.db
      .select()
      .from(orderBoxes)
      .where(and(eq(orderBoxes.id, boxId), eq(orderBoxes.tenantId, this.tenantId)))
      .limit(1);
    const box = boxRows[0];
    if (!box) throw new KernelError("RESOURCE_NOT_FOUND", `箱不存在：${boxId}`);
    if (box.status === "VOIDED") throw new KernelError("KERNEL_REJECTED", "箱已作废");

    const nextSeq = box.seq + 1;
    const qr = buildBoxQr({
      tenantId: this.tenantId,
      orderId: box.orderId,
      boxNo: box.boxNo,
      seq: nextSeq,
    });
    await this.db.transaction(async (tx) => {
      await tx
        .update(boxLabels)
        .set({ status: "VOIDED", voidedAt: new Date(), voidReason: input.reason })
        .where(and(eq(boxLabels.boxId, boxId), eq(boxLabels.status, "ACTIVE")));
      await tx.insert(boxLabels).values({
        tenantId: this.tenantId,
        boxId,
        seq: nextSeq,
        qrPayload: qr,
        status: "ACTIVE",
      });
      await tx
        .update(orderBoxes)
        .set({ seq: nextSeq, updatedAt: new Date() })
        .where(eq(orderBoxes.id, boxId));
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_LABEL_REISSUED",
          entityType: "order_box",
          entityId: boxId,
          before: { seq: box.seq },
          after: { seq: nextSeq, reason: input.reason, qr },
        },
        this.tenantId,
      );
    });
    return this.enqueue(
      {
        kind: "BOX_LABEL",
        shipmentId: box.shipmentId,
        boxId,
        copies: input.copies ?? 1,
        reprintReason: input.reason,
        ...(input.printerId ? { printerId: input.printerId } : {}),
      },
      ctx,
    ).then(async (result) => ({
      ...result,
      shipment: await this.views.getShipmentView(box.shipmentId),
    }));
  }

  async voidBox(boxId: string, reason: string, ctx: KernelContext) {
    const rows = await this.db
      .select()
      .from(orderBoxes)
      .where(and(eq(orderBoxes.id, boxId), eq(orderBoxes.tenantId, this.tenantId)))
      .limit(1);
    const box = rows[0];
    if (!box) throw new KernelError("RESOURCE_NOT_FOUND", `箱不存在：${boxId}`);
    await this.db.transaction(async (tx) => {
      await tx
        .update(orderBoxes)
        .set({ status: "VOIDED", updatedAt: new Date() })
        .where(eq(orderBoxes.id, boxId));
      await tx
        .update(boxLabels)
        .set({ status: "VOIDED", voidedAt: new Date(), voidReason: reason.slice(0, 64) })
        .where(and(eq(boxLabels.boxId, boxId), eq(boxLabels.status, "ACTIVE")));
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_BOX_VOIDED",
          entityType: "order_box",
          entityId: boxId,
          before: { status: box.status },
          after: { status: "VOIDED", reason },
        },
        this.tenantId,
      );
    });
    return this.views.getShipmentView(box.shipmentId);
  }

  /** 扫码复核：累计扫描量必须等于箱内应有量；不一致立即把打印入口锁住。 */
  async verifyScan(input: unknown, ctx: KernelContext): Promise<ScanResult> {
    const parsed = VerifyScanInput.parse(input);
    const view = await this.views.getShipmentView(parsed.shipmentId);
    const qr = parseBoxQr(parsed.boxQr);
    if (!qr || qr.tenantId !== this.tenantId || qr.orderId !== view.orderId) {
      return ScanResult.parse({
        ok: false,
        result: "UNKNOWN_CODE",
        message: "二维码无法识别，或不属于本单",
        box: null,
        expected: null,
        actual: null,
        shipment: view,
      });
    }
    const box = view.boxes.find(
      (item) => item.boxNo === qr.boxNo && item.seq === qr.seq && item.qr === parsed.boxQr,
    );
    if (!box) {
      return ScanResult.parse({
        ok: false,
        result: "WRONG_BOX",
        message: `箱 ${qr.boxNo} 的标签已作废或不属于本发货单`,
        box: null,
        expected: null,
        actual: null,
        shipment: view,
      });
    }
    const sampleRows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), eq(samples.code, parsed.itemCode.trim())))
      .limit(1);
    const sample = sampleRows[0];
    const orderItemRows = sample
      ? await this.db
          .select()
          .from(orderItems)
          .where(and(eq(orderItems.orderId, view.orderId), eq(orderItems.sampleId, sample.id)))
      : [];
    const shipmentItem = orderItemRows[0]
      ? view.items.find((item) => item.orderItemId === orderItemRows[0]!.id)
      : undefined;
    if (!shipmentItem) {
      await this.recordScan({
        shipmentId: parsed.shipmentId,
        boxId: box.id,
        type: "VERIFY",
        result: "MISMATCH",
        qrPayload: parsed.boxQr,
        orderItemId: null,
        quantityMilli: quantityToMilli(parsed.quantity),
        unit: "piece",
        scannedBy: ctx.actor.id,
        message: `商品码 ${parsed.itemCode} 不在本单`,
      });
      return ScanResult.parse({
        ok: false,
        result: "MISMATCH",
        message: `商品码 ${parsed.itemCode} 不在本单`,
        box,
        expected: null,
        actual: { quantity: parsed.quantity, unit: "piece" },
        shipment: await this.views.getShipmentView(parsed.shipmentId),
      });
    }

    const boxItem = box.items.find((item) => item.orderItemId === shipmentItem.orderItemId);
    const expectedMilli = boxItem ? quantityToMilli(boxItem.quantity) : 0;
    const priorRows = await this.db
      .select({ quantityMilli: scanEvents.quantityMilli })
      .from(scanEvents)
      .where(
        and(
          eq(scanEvents.tenantId, this.tenantId),
          eq(scanEvents.boxId, box.id),
          eq(scanEvents.type, "VERIFY"),
          eq(scanEvents.result, "OK"),
          eq(scanEvents.orderItemId, shipmentItem.orderItemId),
        ),
      );
    const prior = priorRows.reduce((sum, row) => sum + (row.quantityMilli ?? 0), 0);
    const actualMilli = prior + quantityToMilli(parsed.quantity);
    const ok = expectedMilli > 0 && actualMilli === expectedMilli;
    const message = ok
      ? `箱 ${box.boxNo} · ${shipmentItem.description} 复核通过`
      : expectedMilli === 0
        ? `箱 ${box.boxNo} 不应包含 ${shipmentItem.description}`
        : `箱 ${box.boxNo} 应有 ${milliToQuantity(expectedMilli)} ${boxItem?.unit ?? ""}，` +
          `实扫 ${milliToQuantity(actualMilli)}`;

    await this.recordScan({
      shipmentId: parsed.shipmentId,
      boxId: box.id,
      type: "VERIFY",
      result: ok ? "OK" : "MISMATCH",
      qrPayload: parsed.boxQr,
      orderItemId: shipmentItem.orderItemId,
      quantityMilli: quantityToMilli(parsed.quantity),
      unit: boxItem?.unit ?? shipmentItem.unit,
      scannedBy: ctx.actor.id,
      message,
    });

    if (!ok) {
      await this.db
        .update(orderBoxes)
        .set({ hasDiscrepancy: true, updatedAt: new Date() })
        .where(eq(orderBoxes.id, box.id));
      await appendAudit(
        this.db,
        ctx,
        {
          action: "PRINT_DISCREPANCY_FLAGGED",
          entityType: "order_box",
          entityId: box.id,
          before: { hasDiscrepancy: box.hasDiscrepancy },
          after: { hasDiscrepancy: true, message },
        },
        this.tenantId,
      );
    } else {
      const verified = await this.boxFullyVerified(box);
      if (verified) {
        await this.db
          .update(orderBoxes)
          .set({
            status: "PACKED",
            verifiedAt: new Date(),
            verifiedBy: ctx.actor.id,
            updatedAt: new Date(),
          })
          .where(eq(orderBoxes.id, box.id));
      }
    }

    const fresh = await this.views.getShipmentView(parsed.shipmentId);
    return ScanResult.parse({
      ok,
      result: ok ? "OK" : "MISMATCH",
      message,
      box: fresh.boxes.find((item) => item.id === box.id) ?? null,
      expected: {
        quantity: milliToQuantity(expectedMilli),
        unit: boxItem?.unit ?? shipmentItem.unit,
        description: shipmentItem.description,
      },
      actual: { quantity: milliToQuantity(actualMilli), unit: shipmentItem.unit },
      shipment: fresh,
    });
  }

  private async boxFullyVerified(box: OrderBox): Promise<boolean> {
    const rows = await this.db
      .select({
        orderItemId: scanEvents.orderItemId,
        quantityMilli: scanEvents.quantityMilli,
      })
      .from(scanEvents)
      .where(
        and(
          eq(scanEvents.tenantId, this.tenantId),
          eq(scanEvents.boxId, box.id),
          eq(scanEvents.type, "VERIFY"),
          eq(scanEvents.result, "OK"),
        ),
      );
    const scanned = new Map<string, number>();
    for (const row of rows) {
      if (!row.orderItemId) continue;
      scanned.set(row.orderItemId, (scanned.get(row.orderItemId) ?? 0) + (row.quantityMilli ?? 0));
    }
    return box.items.every(
      (item) => (scanned.get(item.orderItemId) ?? 0) >= quantityToMilli(item.quantity),
    );
  }

  /** 拣货扫描：样品码命中订单行，累计拣货量不得超过发货量。 */
  async pickScan(input: unknown, ctx: KernelContext): Promise<ScanResult> {
    const parsed = PickScanInput.parse(input);
    const view = await this.views.getShipmentView(parsed.shipmentId);
    const sampleRows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.tenantId, this.tenantId), eq(samples.code, parsed.code.trim())))
      .limit(1);
    const sample = sampleRows[0];
    if (!sample) {
      return ScanResult.parse({
        ok: false,
        result: "UNKNOWN_CODE",
        message: `无法识别的商品码：${parsed.code}`,
        box: null,
        expected: null,
        actual: null,
        shipment: view,
      });
    }
    const orderItemRows = await this.db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, view.orderId), eq(orderItems.sampleId, sample.id)));
    const item = orderItemRows[0]
      ? view.items.find((candidate) => candidate.orderItemId === orderItemRows[0]!.id)
      : undefined;
    if (!item) {
      return ScanResult.parse({
        ok: false,
        result: "MISMATCH",
        message: `${sample.code} 不在本发货单`,
        box: null,
        expected: null,
        actual: null,
        shipment: view,
      });
    }
    const priorRows = await this.db
      .select({ quantityMilli: scanEvents.quantityMilli })
      .from(scanEvents)
      .where(
        and(
          eq(scanEvents.tenantId, this.tenantId),
          eq(scanEvents.shipmentId, parsed.shipmentId),
          eq(scanEvents.type, "PICK"),
          eq(scanEvents.result, "OK"),
          eq(scanEvents.orderItemId, item.orderItemId),
        ),
      );
    const prior = priorRows.reduce((sum, row) => sum + (row.quantityMilli ?? 0), 0);
    const addMilli = quantityToMilli(parsed.quantity ?? 1);
    const actual = prior + addMilli;
    const expected = quantityToMilli(item.quantity);
    const ok = actual <= expected;
    await this.recordScan({
      shipmentId: parsed.shipmentId,
      boxId: null,
      type: "PICK",
      result: ok ? "OK" : "MISMATCH",
      qrPayload: parsed.code,
      orderItemId: item.orderItemId,
      quantityMilli: addMilli,
      unit: item.unit,
      scannedBy: ctx.actor.id,
      message: ok
        ? `已拣 ${milliToQuantity(actual)} / ${item.quantity} ${item.unit}`
        : `拣货超过发货量：${milliToQuantity(actual)} > ${item.quantity}`,
    });
    return ScanResult.parse({
      ok,
      result: ok ? "OK" : "MISMATCH",
      message: ok
        ? `${item.description} 已拣 ${milliToQuantity(actual)} / ${item.quantity} ${item.unit}`
        : `${item.description} 拣货超出：${milliToQuantity(actual)} > ${item.quantity}`,
      box: null,
      expected: { quantity: item.quantity, unit: item.unit, description: item.description },
      actual: { quantity: milliToQuantity(actual), unit: item.unit },
      shipment: await this.views.getShipmentView(parsed.shipmentId),
    });
  }

  async resolveDiscrepancy(boxId: string, note: string, ctx: KernelContext) {
    const rows = await this.db
      .select()
      .from(orderBoxes)
      .where(and(eq(orderBoxes.id, boxId), eq(orderBoxes.tenantId, this.tenantId)))
      .limit(1);
    const box = rows[0];
    if (!box) throw new KernelError("RESOURCE_NOT_FOUND", `箱不存在：${boxId}`);
    await this.db.transaction(async (tx) => {
      await tx
        .update(orderBoxes)
        .set({ hasDiscrepancy: false, note: note.slice(0, 500), updatedAt: new Date() })
        .where(eq(orderBoxes.id, boxId));
      await tx.insert(scanEvents).values({
        tenantId: this.tenantId,
        shipmentId: box.shipmentId,
        boxId,
        type: "VERIFY",
        result: "OK",
        qrPayload: null,
        orderItemId: null,
        quantityMilli: null,
        unit: null,
        scannedBy: ctx.actor.id,
        message: `人工核对差异：${note}`,
      });
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_SCAN_RECORDED",
          entityType: "order_box",
          entityId: boxId,
          before: { hasDiscrepancy: true },
          after: { hasDiscrepancy: false, note },
        },
        this.tenantId,
      );
    });
    return this.views.getShipmentView(box.shipmentId);
  }

  private async recordScan(input: {
    shipmentId: string;
    boxId: string | null;
    type: "PICK" | "VERIFY";
    result: "OK" | "MISMATCH" | "UNKNOWN_CODE" | "WRONG_BOX";
    qrPayload: string | null;
    orderItemId: string | null;
    quantityMilli: number | null;
    unit: Unit | null;
    scannedBy: string;
    message: string;
  }): Promise<void> {
    await this.db.insert(scanEvents).values({
      tenantId: this.tenantId,
      shipmentId: input.shipmentId,
      boxId: input.boxId,
      type: input.type,
      result: input.result,
      qrPayload: input.qrPayload,
      orderItemId: input.orderItemId,
      quantityMilli: input.quantityMilli,
      unit: input.unit,
      scannedBy: input.scannedBy,
      message: input.message,
    });
  }
}
