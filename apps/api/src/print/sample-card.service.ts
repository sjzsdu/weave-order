import { and, asc, eq } from "drizzle-orm";
import { customers, memberships, quoteItems, quotes, samples, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { PrintPreviewArtifact, PrintPreviewInput } from "@weave-order/schema";
import type { PrintTemplateFormat } from "@weave-order/schema";
import { KernelError } from "../kernel/errors";
import { quoteNumberOf } from "../kernel/quotes.service";
import { buildSampleCardUrl, createSampleCardToken } from "../kernel/share-token";
import {
  assertSampleCardPrintable,
  assertSampleCodeFitsToken,
  renderSampleCardHtml,
  renderSampleCardPdf,
  renderSampleCardText,
  sampleCardPreviewFields,
  sampleCardQrDataUrl,
  sampleCardValues,
} from "./sample-card";
import type { SampleCardSource } from "./sample-card";
import type { PrintTemplateService, ResolvedTemplate } from "./print-templates.service";
import { PrintError } from "./template-engine";
import type { TemplateValues } from "./template-engine";

/** 样卡上的时间用北京时间、精确到分钟：纸上不印毫秒与 UTC 后缀。 */
function printedAtText(date: Date): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

/**
 * 样卡的数据来源、校验与渲染。
 *
 * 唯一允许出卡的前置：报价已确认（`SENT` / `ACCEPTED`）。草稿报价打出来的
 * 样卡会带着未定稿的信息跟着样品流出去，因此直接拒绝而不是加提示。
 *
 * 预览与入队共用 `render`：预览返回的 HTML/PDF/标签文本就是入队时交给打印的
 * 那一份，不存在「预览好看、纸上不一样」的空间。
 */
export class SampleCardService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly options: { shareSecret: string; publicAppUrl: string },
    private readonly templates: PrintTemplateService,
  ) {}

  /** 报价已确认才算「可以出样卡」。 */
  private async loadConfirmedQuote(quoteId: string) {
    const rows = await this.db
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, quoteId), eq(quotes.tenantId, this.tenantId)))
      .limit(1);
    const quote = rows[0];
    if (!quote) {
      throw new KernelError("RESOURCE_NOT_FOUND", `报价单不存在：${quoteId}`, {
        resourceType: "quote",
        resourceId: quoteId,
      });
    }
    if (quote.status !== "SENT" && quote.status !== "ACCEPTED") {
      throw new KernelError(
        "KERNEL_REJECTED",
        `报价还没有确认价格（当前 ${quote.status}），不能打印样卡`,
        { reason: "PRINT_QUOTE_NOT_CONFIRMED" },
      );
    }
    return quote;
  }

  async lineCount(quoteId: string): Promise<number> {
    await this.loadConfirmedQuote(quoteId);
    const rows = await this.db
      .select({ id: quoteItems.id })
      .from(quoteItems)
      .where(eq(quoteItems.quoteId, quoteId));
    return rows.length;
  }

  /**
   * 业务员联系方式：租户设置 `settings.salesContact`（报价链接名片同一份）。
   * 姓名缺失时回落到报价确认人 / 客户负责人的成员姓名；电话只认设置，
   * 因为「打过去找不到人」比「没有电话」更糟。
   */
  private async salesperson(
    settings: Record<string, unknown>,
    quoteConfirmedBy: string | null,
    customerOwnerId: string | null,
  ): Promise<{ name: string | null; phone: string | null }> {
    const raw = settings.salesContact;
    const contact =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const name =
      typeof contact.name === "string" && contact.name.trim() ? contact.name.trim() : null;
    const phone =
      typeof contact.phone === "string" && contact.phone.trim()
        ? contact.phone.trim()
        : typeof settings.printPhone === "string" && settings.printPhone.trim()
          ? settings.printPhone.trim()
          : null;
    if (name) return { name, phone };

    const subject = quoteConfirmedBy ?? customerOwnerId;
    if (!subject) return { name: null, phone };
    const rows = await this.db
      .select({ displayName: memberships.displayName })
      .from(memberships)
      .where(and(eq(memberships.tenantId, this.tenantId), eq(memberships.subject, subject)))
      .limit(1);
    return { name: rows[0]?.displayName?.trim() || null, phone };
  }

  /** 报价行 → 样卡数据源。一张卡只对应一个样品。 */
  async buildSource(input: {
    quoteId: string;
    lineIndex: number;
    operator: string;
    reprintReason: string | null;
    printedAt?: Date;
  }): Promise<SampleCardSource> {
    const quote = await this.loadConfirmedQuote(input.quoteId);

    const lineRows = await this.db
      .select()
      .from(quoteItems)
      .where(eq(quoteItems.quoteId, quote.id))
      .orderBy(asc(quoteItems.position));
    const line = lineRows[input.lineIndex];
    if (!line) {
      throw new KernelError(
        "RESOURCE_NOT_FOUND",
        `报价没有第 ${input.lineIndex + 1} 行样品（共 ${lineRows.length} 行），无法出样卡`,
        { resourceType: "quote", resourceId: quote.id },
      );
    }

    const sampleRows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.id, line.sampleId), eq(samples.tenantId, this.tenantId)))
      .limit(1);
    const sample = sampleRows[0];
    if (!sample) {
      throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${line.sampleId}`);
    }

    const tenantRows = await this.db
      .select({ name: tenants.name, brand: tenants.brand, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, this.tenantId))
      .limit(1);
    const tenant = tenantRows[0];
    const settings = (tenant?.settings ?? {}) as Record<string, unknown>;

    const customerRows = await this.db
      .select({ ownerId: customers.ownerId })
      .from(customers)
      .where(and(eq(customers.id, quote.customerId), eq(customers.tenantId, this.tenantId)))
      .limit(1);
    const salesperson = await this.salesperson(
      settings,
      quote.confirmedBy,
      customerRows[0]?.ownerId ?? null,
    );

    // token 之前先校验编号：超限要变成可读的业务错误，而不是 500。
    assertSampleCodeFitsToken(sample.code);
    const token = createSampleCardToken(
      { tenantId: this.tenantId, sampleCode: sample.code },
      this.options.shareSecret,
    );
    const qrPayload = buildSampleCardUrl(this.options.publicAppUrl, token);

    return {
      quoteNo: quoteNumberOf(quote),
      sample: {
        code: sample.code,
        name: sample.name,
        composition: sample.composition,
        weight: sample.weight,
        category: sample.category,
      },
      tenant: {
        name: tenant?.name ?? "",
        brand:
          tenant?.brand?.trim() ||
          (typeof settings.brand === "string" && settings.brand.trim()
            ? settings.brand.trim()
            : null),
      },
      salesperson,
      qrPayload,
      qrImageDataUrl: await sampleCardQrDataUrl(qrPayload),
      printedAt: printedAtText(input.printedAt ?? new Date()),
      operator: input.operator,
      reprintReason: input.reprintReason,
    };
  }

  /** A4 返回 HTML + PDF，标签返回 ZPL/TSPL；预览与入队都走这里。 */
  async render(input: {
    source: SampleCardSource;
    values: TemplateValues;
    resolved: ResolvedTemplate;
    format: PrintTemplateFormat;
  }): Promise<{ html: string | null; pdfBase64: string | null; text: string | null }> {
    if (input.format === "HTML") {
      const html = renderSampleCardHtml(input.resolved.body, input.values);
      const pdf = await renderSampleCardPdf(input.source, html);
      return { html, pdfBase64: pdf.toString("base64"), text: null };
    }
    const text = renderSampleCardText(input.resolved.body, input.values, input.format);
    return { html: null, pdfBase64: null, text };
  }

  /** 预览 = 产物。传 override 时用编辑器里的模板（含未发布草稿）渲染。 */
  async preview(input: unknown, operator: string, override?: ResolvedTemplate) {
    const parsed = PrintPreviewInput.parse(input);
    if (parsed.kind !== "SAMPLE_LABEL") {
      throw new PrintError("PRINT_UNSUPPORTED_KIND", `暂不支持预览：${parsed.kind}`);
    }
    const source = await this.buildSource({
      quoteId: parsed.quoteId,
      lineIndex: parsed.lineIndex,
      operator,
      reprintReason: null,
    });
    const values = sampleCardValues(source);
    assertSampleCardPrintable(values);
    const resolved =
      override ??
      (await this.templates.resolve({
        kind: "SAMPLE_LABEL",
        format: parsed.format,
        ...(parsed.templateId ? { templateId: parsed.templateId } : {}),
      }));
    // 模板自己有格式（A4 / ZPL / TSPL），预览按模板实际格式渲染，不按请求猜。
    const format = resolved.format;
    const rendered = await this.render({ source, values, resolved, format });
    return PrintPreviewArtifact.parse({
      kind: "SAMPLE_LABEL",
      quoteId: parsed.quoteId,
      lineIndex: parsed.lineIndex,
      format,
      templateName: resolved.name,
      pageSize: resolved.pageSize,
      isSystem: resolved.isSystem,
      sampleCode: source.sample.code,
      qrPayload: source.qrPayload,
      html: rendered.html,
      pdfBase64: rendered.pdfBase64,
      text: rendered.text,
      fields: sampleCardPreviewFields(values),
    });
  }
}
