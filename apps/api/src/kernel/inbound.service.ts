import { and, eq, inArray } from "drizzle-orm";
import { intents, ocrResults, sources } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  InboundAttachmentView,
  InboundDetail,
  ReviseInboundInput,
  StartInboundInput,
  SubmitInboundInput,
  SubmitInboundResult,
  parseWeightMeasurement,
  parseWidthMeasurement,
} from "@weave-order/schema";
import type {
  InboundAttachmentKind,
  IntentDraft,
  IntentUnderstanding,
  IntentView,
  JsonValue,
} from "@weave-order/schema";
import { randomUUID } from "node:crypto";
import type { ObjectStorage } from "../platform/storage";
import { OcrError, mimeTypeOf } from "../platform/ocr";
import type { OcrDocumentKind, OcrGateway } from "../platform/ocr";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";
import type { IntentService } from "./intents.service";
import { buildUnderstanding, inboundReadiness, reviseUnderstanding } from "./inbound-understanding";
import type { InboundSourceInsight } from "./inbound-understanding";
import type { CustomerService } from "./customers.service";
import type { ItemService } from "./items.service";
import type { SampleService } from "./samples.service";

type IntentRow = typeof intents.$inferSelect;
type SourceRow = typeof sources.$inferSelect;
type OcrRow = typeof ocrResults.$inferSelect;

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const PDF_MIME = "application/pdf";

export interface InboundTaskOutcome {
  kind: "quote" | "sample" | "customer";
  sourceId: string | null;
  status: "SUCCEEDED" | "NEEDS_INPUT" | "FAILED";
  resourceId: string | null;
  resourceType: "customer" | "sample" | "item" | null;
  message: string | null;
}

export interface InboundExecuteResult {
  intent: IntentView;
  understanding: IntentUnderstanding;
  outcomes: InboundTaskOutcome[];
  /** 主产物建议的跳转（事项 / 客户 / 样品），执行器据此做二次动作。 */
  draft: IntentDraft | null;
}

function clamp(value: string, size = 500): string {
  return value.slice(0, size);
}

function messageOf(error: unknown): string {
  return clamp(error instanceof Error ? error.message : String(error), 300);
}

function kindOfAttachment(
  hint: InboundAttachmentKind,
  mimeType: string,
  text: string,
): InboundAttachmentKind {
  if (hint !== "auto") return hint;
  if (mimeType === PDF_MIME) return "document";
  if (/公司|地址|电话|手机|邮箱|联系人|名片|Tel|Mobile/i.test(text)) return "bizcard";
  if (/成分|克重|门幅|幅宽|棉|涤|锦|毛|GSM|%|洗涤/i.test(text)) return "label";
  return "auto";
}

function documentKind(kind: InboundAttachmentKind): OcrDocumentKind {
  return kind === "bizcard" ? "bizcard" : "label";
}

function attachmentView(row: OcrRow): InboundAttachmentView {
  const raw = (row.raw ?? {}) as Record<string, unknown>;
  const kind = typeof raw.kindHint === "string" ? (raw.kindHint as InboundAttachmentKind) : "auto";
  const text = typeof raw.ocrText === "string" ? raw.ocrText : null;
  return InboundAttachmentView.parse({
    sourceId: row.sourceId,
    kind,
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : null,
    ocrStatus: row.status,
    failureCode: row.failureCode ?? null,
    attempts: row.attempts,
    textPreview: text ? text.slice(0, 500) : null,
  });
}

/**
 * 统一输入（P0a-3）的确定性内核。
 *
 * 职责边界：
 * - 提交：只落一条 `intents` 行 + 原件 `sources`；不调用模型，避免请求挂 10 秒；
 * - 理解：后台 OCR + 纯函数理解卡，失败一律留空并 `NEEDS_INPUT`，不假装成功；
 * - 执行：只建「草稿」资源，客户/样品按 `sourceId` 幂等，重试不重复建；
 * - 报价：建事项（先查再建），真正的报价草稿仍由报价 agent 在 HTTP 执行器里产出。
 */
export class InboundService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly deps: {
      ocr: OcrGateway;
      storage: ObjectStorage;
      intents: IntentService;
      customers: CustomerService;
      samples: SampleService;
      items: ItemService;
    },
  ) {}

  async submit(
    raw: unknown,
    ctx: KernelContext,
  ): Promise<SubmitInboundResult & { created: boolean }> {
    const input = SubmitInboundInput.parse(raw);
    const expectedPrefix = `tenant/${this.tenantId}/inbound/`;
    // 先校验附件归属再落库：否则非法 key 会留下一条没有原件的 QUEUED 记录。
    for (const attachment of input.attachments ?? []) {
      if (!attachment.objectKey.startsWith(expectedPrefix)) {
        throw new KernelError("PERMISSION_DENIED", "附件不属于当前租户的上传目录", {
          reason: "INBOUND_OBJECT_KEY_INVALID",
        });
      }
    }
    const submitted = await this.deps.intents.submitInbound(input, ctx);
    // 同一 clientRequestId 的重放：只返回首次记录，不再建原件。
    if (!submitted.created) {
      return {
        ...SubmitInboundResult.parse({
          inboundId: submitted.intent.id,
          status: submitted.intent.status,
          intent: submitted.intent,
        }),
        created: false,
      };
    }

    const sourceIds: string[] = [];
    for (const attachment of input.attachments ?? []) {
      const mimeType = mimeTypeOf(attachment.objectKey, attachment.mimeType);
      const rows = await this.db
        .insert(sources)
        .values({
          tenantId: this.tenantId,
          kind: mimeType === PDF_MIME ? "PDF" : "IMAGE",
          objectKey: attachment.objectKey,
          textContent: null,
          mimeType,
          byteSize: attachment.byteSize ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new KernelError("KERNEL_REJECTED", "原件写入未返回记录");
      sourceIds.push(row.id);
      await this.db.insert(ocrResults).values({
        tenantId: this.tenantId,
        sourceId: row.id,
        engine: this.deps.ocr.name,
        raw: { kindHint: attachment.kind, mimeType },
        fields: null,
        status: "PENDING",
        failureCode: null,
        attempts: 0,
      });
    }
    // 纯文本也要有原件：字段出处与草稿幂等键都必须指向一条真实 `sources` 行。
    // 文本原件排在最后：无附件任务回退到它，不会把名片图当成文字原件。
    if (input.text && input.text.trim().length > 0) {
      const rows = await this.db
        .insert(sources)
        .values({
          tenantId: this.tenantId,
          kind: "TEXT",
          objectKey: null,
          textContent: input.text.trim(),
          mimeType: null,
          byteSize: null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new KernelError("KERNEL_REJECTED", "文本原件写入未返回记录");
      sourceIds.push(row.id);
    }
    if (sourceIds.length > 0) await this.deps.intents.attachSources(submitted.intent.id, sourceIds);
    const intent = await this.deps.intents.get(submitted.intent.id);
    return {
      ...SubmitInboundResult.parse({ inboundId: intent.id, status: intent.status, intent }),
      created: true,
    };
  }

  /** 后台理解：OCR + 理解卡。所有失败都变成可解释的 NEEDS_INPUT，不会「成功但字段为空」。 */
  async understand(id: string): Promise<InboundDetail> {
    const row = await this.deps.intents.getRow(id);
    if (row.status === "CANCELLED") return this.detailOf(row);
    await this.deps.intents.resumeRunning(id);
    const insights = await this.runOcr(row);
    const context = (row.context ?? null) as Record<string, unknown> | null;
    const understanding = buildUnderstanding({
      text: row.text,
      sources: insights,
      context,
    });
    const readiness = inboundReadiness(understanding);
    await this.deps.intents.saveUnderstanding(id, understanding, readiness.ready, readiness.reason);
    return this.getDetail(id);
  }

  async getDetail(id: string): Promise<InboundDetail> {
    const row = await this.deps.intents.getRow(id);
    return this.detailOf(row);
  }

  /** 纠正理解：只改卡，不执行。kind 改对后再次 start 即按新 kind 执行。 */
  async revise(id: string, raw: unknown): Promise<InboundDetail> {
    const input = ReviseInboundInput.parse(raw);
    const row = await this.deps.intents.getRow(id);
    if (!row.understanding) {
      throw new KernelError("KERNEL_REJECTED", "理解卡还没生成，稍后再试", {
        reason: "INBOUND_UNDERSTANDING_NOT_READY",
        resourceType: "intent",
        resourceId: id,
      });
    }
    const insights = await this.loadInsights(row);
    const next = reviseUnderstanding(
      row.understanding,
      {
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.slots ? { slots: input.slots } : {}),
        ...(input.fields
          ? {
              fields: input.fields.map((entry) => ({
                fieldName: entry.fieldName,
                value: entry.value,
              })),
            }
          : {}),
      },
      insights,
    );
    const readiness = inboundReadiness(next);
    await this.deps.intents.saveUnderstanding(id, next, readiness.ready, readiness.reason);
    return this.getDetail(id);
  }

  /**
   * 用户确认理解卡并触发执行。
   * 这里只把本次修改并进理解卡、把卡上已有值标为「用户看过」，然后进入 RUNNING；
   * 真正的资源草稿由执行器异步建，HTTP 不等模型。
   */
  async start(id: string, raw: unknown, _ctx: KernelContext): Promise<InboundDetail> {
    const input = StartInboundInput.parse(raw);
    const row = await this.deps.intents.getRow(id);
    if (!row.understanding) {
      throw new KernelError("KERNEL_REJECTED", "理解卡还没生成，稍后再试", {
        reason: "INBOUND_UNDERSTANDING_NOT_READY",
        resourceType: "intent",
        resourceId: id,
      });
    }
    const insights = await this.loadInsights(row);
    const next = reviseUnderstanding(
      row.understanding,
      {
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.slots ? { slots: input.slots } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
      },
      insights,
    );
    // 用户按下「确认」：有值的字段视为看过；空值仍待补，不伪造确认。
    const confirmed: IntentUnderstanding = {
      ...next,
      fields: next.fields.map((card) =>
        typeof card.value === "string" && card.value.trim().length > 0
          ? { ...card, status: "CONFIRMED", pending: false }
          : card,
      ),
    };
    await this.deps.intents.saveUnderstanding(id, confirmed, true, null);
    await this.deps.intents.resumeRunning(id);
    return this.getDetail(id);
  }

  /**
   * 执行任务（由后台执行器调用）。
   * 同一个 `sourceId` 的客户/样品草稿天然幂等：重复调用返回同一行。
   */
  async execute(id: string, ctx: KernelContext): Promise<InboundExecuteResult> {
    const row = await this.deps.intents.getRow(id);
    if (!row.understanding) {
      throw new KernelError("KERNEL_REJECTED", "理解卡还没生成，无法执行", {
        reason: "INBOUND_UNDERSTANDING_NOT_READY",
        resourceType: "intent",
        resourceId: id,
      });
    }
    if (row.status !== "RUNNING") await this.deps.intents.resumeRunning(id);

    const outcomes: InboundTaskOutcome[] = [];
    let primaryDraft: IntentDraft | null = null;
    const fields = row.understanding.fields;
    for (const task of row.understanding.tasks) {
      try {
        if (task.kind === "customer") {
          const result = await this.executeCustomer(row, task.sourceId, fields, ctx);
          outcomes.push(result);
          if (result.status === "SUCCEEDED" && result.resourceId) {
            primaryDraft ??= { kind: "customer", id: result.resourceId, title: "客户草稿" };
          }
        } else if (task.kind === "sample") {
          const result = await this.executeSample(row, task.sourceId, fields, ctx);
          outcomes.push(result);
          if (result.status === "SUCCEEDED" && result.resourceId) {
            primaryDraft ??= { kind: "sample", id: result.resourceId, title: "样品草稿" };
          }
        } else {
          const result = await this.executeQuote(row, task.sourceId, ctx);
          outcomes.push(result);
          if (result.status === "SUCCEEDED" && result.resourceId) {
            primaryDraft ??= { kind: "quote", id: result.resourceId, title: "业务事项" };
          }
        }
      } catch (error) {
        outcomes.push({
          kind: task.kind,
          sourceId: task.sourceId,
          status: "FAILED",
          resourceId: null,
          resourceType: null,
          message: messageOf(error),
        });
      }
    }

    const next: IntentUnderstanding = {
      ...row.understanding,
      tasks: row.understanding.tasks.map((task, index) => {
        const outcome = outcomes[index];
        if (!outcome) return task;
        return {
          ...task,
          status: outcome.status,
          resourceId: outcome.resourceId,
          resourceType: outcome.resourceType,
          message: outcome.message,
        };
      }),
    };

    const failed = outcomes.find((outcome) => outcome.status !== "SUCCEEDED");
    if (failed) {
      const reason = outcomes
        .filter((outcome) => outcome.status !== "SUCCEEDED")
        .map((outcome) => outcome.message)
        .filter(Boolean)
        .join("；");
      if (failed.status === "FAILED") {
        await this.deps.intents.markFailed(id, reason || "执行失败");
      } else {
        await this.deps.intents.saveUnderstanding(id, next, false, reason || "还差一些信息");
      }
      return {
        intent: await this.deps.intents.get(id),
        understanding: next,
        outcomes,
        draft: null,
      };
    }

    const intent = primaryDraft
      ? await this.deps.intents.completeInbound(id, primaryDraft, next)
      : await this.deps.intents.saveUnderstanding(id, next, true, null);
    return { intent, understanding: next, outcomes, draft: primaryDraft };
  }

  private fallbackSourceId(row: IntentRow): string {
    // 文本原件最后写入，是「没有指定附件」时最诚实的出处；只有老数据才会为空。
    return row.attachments[row.attachments.length - 1] ?? row.id;
  }

  private async executeCustomer(
    row: IntentRow,
    sourceId: string | null,
    fields: IntentUnderstanding["fields"],
    ctx: KernelContext,
  ): Promise<InboundTaskOutcome> {
    const map = new Map(fields.map((card) => [card.fieldName, card]));
    const text = (name: string): string | null => {
      const value = map.get(name)?.value;
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    };
    const name = text("name");
    if (!name) {
      return {
        kind: "customer",
        sourceId,
        status: "NEEDS_INPUT",
        resourceId: null,
        resourceType: null,
        message: "还缺客户名称",
      };
    }
    const extra = ["title", "address", "business"]
      .map((fieldName) => {
        const value = text(fieldName);
        if (!value) return null;
        return {
          fieldName,
          value,
          sourceKind: map.get(fieldName)?.sourceKind ?? "manual",
          sourceId: map.get(fieldName)?.sourceId ?? null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const created = await this.deps.customers.createDraft(
      {
        sourceId: sourceId ?? this.fallbackSourceId(row),
        name,
        ...(text("contactName") ? { contactName: text("contactName") } : {}),
        ...(text("contactPhone") ? { contactPhone: text("contactPhone") } : {}),
        ...(text("contactEmail") ? { contactEmail: text("contactEmail") } : {}),
        ...(extra.length > 0 ? { fields: extra } : {}),
      },
      ctx,
    );
    return {
      kind: "customer",
      sourceId,
      status: "SUCCEEDED",
      resourceId: created.customer.id,
      resourceType: "customer",
      message: created.created ? "客户草稿已建，待逐字段确认" : "接续已有客户草稿",
    };
  }

  private async executeSample(
    row: IntentRow,
    sourceId: string | null,
    fields: IntentUnderstanding["fields"],
    ctx: KernelContext,
  ): Promise<InboundTaskOutcome> {
    const map = new Map(fields.map((card) => [card.fieldName, card]));
    const text = (name: string): string | null => {
      const value = map.get(name)?.value;
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    };
    const name = text("name");
    if (!name) {
      return {
        kind: "sample",
        sourceId,
        status: "NEEDS_INPUT",
        resourceId: null,
        resourceType: null,
        message: "还缺样品品名",
      };
    }
    // 克重 / 门幅：OCR 给的是原文，落库前先解析成「数值 + 单位」。
    // 解析不出就留空（宁可留空也不猜），由人在确认页补。
    const weight = parseWeightMeasurement(text("weight"));
    const width = parseWidthMeasurement(text("width"));
    const extra = ["lot", "supplier"]
      .map((fieldName) => {
        const value = text(fieldName);
        if (!value) return null;
        return {
          fieldName,
          value,
          sourceKind: map.get(fieldName)?.sourceKind ?? "manual",
          sourceId: map.get(fieldName)?.sourceId ?? null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const created = await this.deps.samples.createDraft(
      {
        sourceId: sourceId ?? this.fallbackSourceId(row),
        name,
        ...(text("composition") ? { composition: text("composition") } : {}),
        ...(weight ? { weight } : {}),
        ...(width ? { width } : {}),
        ...(extra.length > 0 ? { fields: extra } : {}),
      },
      ctx,
    );
    return {
      kind: "sample",
      sourceId,
      status: "SUCCEEDED",
      resourceId: created.sample.id,
      resourceType: "sample",
      message: created.created ? "样品草稿已建，待逐字段确认" : "接续已有样品草稿",
    };
  }

  private async executeQuote(
    row: IntentRow,
    sourceId: string | null,
    ctx: KernelContext,
  ): Promise<InboundTaskOutcome> {
    const slots = row.understanding?.slots ?? {};
    const customerId = typeof slots.customerId === "string" ? slots.customerId : null;
    const sampleId = typeof slots.sampleId === "string" ? slots.sampleId : null;
    const quantity = typeof slots.quantity === "number" ? slots.quantity : null;
    const unit = typeof slots.unit === "string" ? slots.unit : "meter";
    if (!customerId || !sampleId || !quantity) {
      return {
        kind: "quote",
        sourceId,
        status: "NEEDS_INPUT",
        resourceId: null,
        resourceType: null,
        message: "报价还缺客户、样品或数量",
      };
    }
    const created = await this.deps.items.create(
      {
        customerId,
        sampleId,
        quantity: { value: quantity, unit: unit as "meter" | "kilogram" | "yard" | "piece" },
        sourceIntentId: row.id,
        currentStage: "正在核对价格",
        nextAction: "确认最终价格",
      },
      ctx,
    );
    if (!created.item) {
      return {
        kind: "quote",
        sourceId,
        status: "NEEDS_INPUT",
        resourceId: null,
        resourceType: null,
        message: created.message,
      };
    }
    return {
      kind: "quote",
      sourceId,
      status: "SUCCEEDED",
      resourceId: created.item.id,
      resourceType: "item",
      message: created.outcome === "CONTINUED" ? "接续已有事项" : "事项已建，待确认价格",
    };
  }

  /** 逐附件 OCR。成功的写入 `ocr_results.fields`，失败的写 failureCode，原件永远保留。 */
  private async runOcr(row: IntentRow): Promise<InboundSourceInsight[]> {
    const existing = await this.loadInsights(row);
    if (row.attachments.length === 0) return existing;
    const pending = await this.db
      .select()
      .from(ocrResults)
      .where(
        and(
          eq(ocrResults.tenantId, this.tenantId),
          inArray(ocrResults.sourceId, [...row.attachments]),
          eq(ocrResults.status, "PENDING"),
        ),
      );
    const sourcesById = new Map(existing.map((insight) => [insight.sourceId, insight]));

    for (const ocr of pending) {
      const raw = (ocr.raw ?? {}) as Record<string, unknown>;
      const hint = (raw.kindHint as InboundAttachmentKind | undefined) ?? "auto";
      const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : null;
      const sourceRows = await this.db
        .select()
        .from(sources)
        .where(and(eq(sources.tenantId, this.tenantId), eq(sources.id, ocr.sourceId)))
        .limit(1);
      const source = sourceRows[0];
      if (!source?.objectKey) {
        await this.markOcrFailed(ocr.id, "UNREADABLE_IMAGE", hint, mimeType);
        continue;
      }
      if (mimeType === PDF_MIME) {
        // P0a 只接图片：PDF 显式标为未识别，任务进入逐字段人工，不猜 PDF 内容。
        await this.markOcrFailed(ocr.id, "UNSUPPORTED_FORMAT", hint, mimeType);
        continue;
      }
      let bytes: Buffer | null = null;
      try {
        bytes = (await this.deps.storage.get(source.objectKey))?.bytes ?? null;
      } catch {
        bytes = null;
      }
      if (!bytes) {
        await this.markOcrFailed(ocr.id, "UNREADABLE_IMAGE", hint, mimeType);
        continue;
      }
      const effectiveMime = mimeTypeFor(ocr, source);
      if (!IMAGE_MIME.has(effectiveMime)) {
        await this.markOcrFailed(ocr.id, "UNSUPPORTED_FORMAT", hint, mimeType);
        continue;
      }
      try {
        const result = await this.deps.ocr.recognize({
          bytes,
          mimeType: effectiveMime,
          kind: documentKind(hint),
        });
        const finalKind =
          hint === "auto"
            ? kindOfAttachment(
                hint,
                effectiveMime,
                `${result.text}\n${Object.values(result.fields).join(" ")}`,
              )
            : hint;
        if (!result.text.trim()) {
          await this.markOcrFailed(ocr.id, "LOW_CONFIDENCE", finalKind, mimeType, result);
        } else {
          await this.db
            .update(ocrResults)
            .set({
              status: "SUCCEEDED",
              fields: result.fields,
              raw: {
                kindHint: finalKind,
                mimeType,
                ocrText: result.text,
                engine: result.engine,
                latencyMs: result.latencyMs,
                stages: result.raw as JsonValue,
              },
              failureCode: null,
              attempts: ocr.attempts + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(ocrResults.tenantId, this.tenantId), eq(ocrResults.id, ocr.id)));
          sourcesById.set(ocr.sourceId, {
            sourceId: ocr.sourceId,
            kind: finalKind,
            ocrStatus: "SUCCEEDED",
            fields: result.fields,
            ocrText: result.text,
            failureCode: null,
          });
        }
      } catch (error) {
        const code = error instanceof OcrError ? error.code : "PROVIDER_ERROR";
        await this.markOcrFailed(ocr.id, code, hint, mimeType);
      }
    }
    return [...sourcesById.values()];
  }

  private async markOcrFailed(
    id: string,
    code: string,
    kindHint: InboundAttachmentKind,
    mimeType: string | null,
    extra: { text?: string; engine?: string } = {},
  ): Promise<void> {
    await this.db
      .update(ocrResults)
      .set({
        status: "FAILED",
        failureCode: code,
        raw: {
          kindHint,
          mimeType,
          ...(extra.text ? { ocrText: extra.text } : {}),
          ...(extra.engine ? { engine: extra.engine } : {}),
        },
        attempts: 1,
        updatedAt: new Date(),
      })
      .where(and(eq(ocrResults.tenantId, this.tenantId), eq(ocrResults.id, id)));
  }

  /** 读已落库的 OCR 结果（理解卡与 revue 都读同一份，不重复调用模型）。 */
  private async loadInsights(row: IntentRow): Promise<InboundSourceInsight[]> {
    if (row.attachments.length === 0) return [];
    const rows = await this.db
      .select()
      .from(ocrResults)
      .where(
        and(
          eq(ocrResults.tenantId, this.tenantId),
          inArray(ocrResults.sourceId, [...row.attachments]),
        ),
      );
    return rows.map((ocr) => {
      const raw = (ocr.raw ?? {}) as Record<string, unknown>;
      const kind =
        typeof raw.kindHint === "string" ? (raw.kindHint as InboundAttachmentKind) : "auto";
      const fields = (ocr.fields ?? {}) as Record<string, string>;
      return {
        sourceId: ocr.sourceId,
        kind,
        ocrStatus: ocr.status,
        fields,
        ocrText: typeof raw.ocrText === "string" ? raw.ocrText : null,
        failureCode: ocr.failureCode ?? null,
      };
    });
  }

  private async detailOf(row: IntentRow): Promise<InboundDetail> {
    const intent = await this.deps.intents.get(row.id);
    const attachments =
      row.attachments.length === 0
        ? []
        : (
            await this.db
              .select()
              .from(ocrResults)
              .where(
                and(
                  eq(ocrResults.tenantId, this.tenantId),
                  inArray(ocrResults.sourceId, [...row.attachments]),
                ),
              )
          ).map(attachmentView);
    const canStart =
      row.status !== "CANCELLED" &&
      row.result === null &&
      row.understanding !== null &&
      (row.status === "SUCCEEDED" || row.status === "NEEDS_INPUT" || row.status === "FAILED");
    return InboundDetail.parse({
      intent,
      understanding: row.understanding ?? null,
      attachments,
      canStart,
      canRevise: row.status !== "CANCELLED" && row.understanding !== null,
      createdAt: intent.createdAt,
    });
  }
}

function mimeTypeFor(ocr: OcrRow, source: SourceRow): string {
  const raw = (ocr.raw ?? {}) as Record<string, unknown>;
  if (typeof raw.mimeType === "string" && raw.mimeType.length > 0) return raw.mimeType;
  return mimeTypeOf(source.objectKey ?? "unknown", source.mimeType);
}

/** 供执行器回写「报价草稿要跳到事项」时使用。 */
export function inboundDraftTitle(kind: IntentDraft["kind"], id: string): string {
  const label = kind === "quote" ? "报价事项" : kind === "sample" ? "样品草稿" : "客户草稿";
  return `${label} ${id.slice(0, 8)}`;
}

/** 便于把 context 里的属性安全取成字符串。 */
export function contextString(context: JsonValue | null | undefined, key: string): string | null {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const value = (context as Record<string, JsonValue>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export { randomUUID };
