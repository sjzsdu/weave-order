import QRCode from "qrcode";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PRINT_VARIABLES } from "@weave-order/schema";
import type { PrintPreviewField, PrintTemplateFormat } from "@weave-order/schema";
import { loadCjkFont } from "./pdf";
import { renderHtmlWithChrome } from "./pdf";
import { PrintError, renderTemplate } from "./template-engine";
import type { TemplateValues } from "./template-engine";

/**
 * 实体样卡（P0b）。
 *
 * 一张样卡只讲三件事：这是什么样品、出问题找谁、扫码能看到同样的信息。
 * 因此卡片上不放价格、客户名、报价数量——那些属于报价单，不属于跟着样品
 * 流出去的纸片；二维码指向的公开页也只回样品编号 + 业务员联系方式。
 *
 * 「预览 = 产物」不是承诺而是结构：预览和入队都调用同一组 render 函数，
 * A4 返回交给打印的 HTML/PDF，标签返回交给打印代理的 ZPL/TSPL 文本。
 */

/** 二维码内容 = 公开页地址；页面只回样品编号 + 业务员联系方式。 */
export const SAMPLE_CARD_FORMAT_LABEL: Record<PrintTemplateFormat, string> = {
  HTML: "A4 样卡",
  ZPL: "80×50mm 标签（ZPL）",
  TSPL: "80×50mm 标签（TSPL）",
};

/**
 * 单行字段长度上限。
 *
 * 上限来自 80×50mm / 203dpi 标签的物理宽度（可用约 72mm）：
 * - 中文按 18 点字号 ≈ 2.25mm/字，一行约 24 字；
 * - 样品编号是 ASCII，36 点字号下约 1.1mm/字，32 个字符刚好写满一行。
 * 超过上限不是「截断」而是显式报错——被截断的样品名会让人拿错样。
 */
export const SAMPLE_CARD_LIMITS = {
  "tenant.name": 20,
  "sample.code": 32,
  "sample.name": 24,
  "sample.composition": 32,
  "sample.weight": 16,
  "sample.category": 12,
  "salesperson.name": 12,
  "salesperson.phone": 20,
} as const;

export type SampleCardFieldPath = keyof typeof SAMPLE_CARD_LIMITS;

/** 缺了就不能出卡的字段：宁可不打，也不打一张找不到人的卡。 */
const REQUIRED_FIELDS: SampleCardFieldPath[] = [
  "tenant.name",
  "sample.code",
  "sample.name",
  "salesperson.name",
  "salesperson.phone",
];

export interface SampleCardSource {
  /** 展示用报价编号，只上 A4 样卡做内部追溯，不上标签。 */
  quoteNo: string;
  sample: {
    code: string;
    name: string;
    composition: string | null;
    weight: string | null;
    category: string | null;
  };
  tenant: { name: string; brand: string | null };
  salesperson: { name: string | null; phone: string | null };
  qrPayload: string;
  qrImageDataUrl: string;
  printedAt: string;
  operator: string;
  reprintReason: string | null;
}

/** 把业务数据拍平成模板可用的标量；null 一律保留，交给完整性校验判死。 */
export function sampleCardValues(source: SampleCardSource): TemplateValues {
  return {
    scalars: {
      "tenant.name": source.tenant.name || null,
      "tenant.brand": source.tenant.brand || source.tenant.name || null,
      "sample.code": source.sample.code || null,
      "sample.name": source.sample.name || null,
      "sample.composition": source.sample.composition || "—",
      "sample.weight": source.sample.weight || "—",
      "sample.category": source.sample.category || "—",
      "quote.no": source.quoteNo,
      "salesperson.name": source.salesperson.name || null,
      "salesperson.phone": source.salesperson.phone || null,
      "card.qr": source.qrPayload,
      "card.qrImage": source.qrImageDataUrl,
      "meta.printedAt": source.printedAt,
      "meta.operator": source.operator,
      "meta.reprintReason": source.reprintReason ?? "—",
      // 样卡没有循环块；模板引擎要求结构完整。
      "box.qr": null,
      "box.no": null,
      "box.seq": null,
      "box.count": null,
      "box.grossWeight": null,
      "box.size": null,
      "box.qty": null,
    },
    loops: {},
  };
}

/**
 * 完整性 + 版面校验。缺字段与超长都抛错，不做「留空 / 截断」的隐式降级：
 * 一张看不清是谁的样卡比打不出来更糟。
 */
export function assertSampleCardPrintable(values: TemplateValues): void {
  const missing = REQUIRED_FIELDS.filter((path) => {
    const value = values.scalars[path];
    return value === null || value === undefined || String(value).trim().length === 0;
  });
  if (missing.length > 0) {
    throw new PrintError(
      "PRINT_MISSING_FIELD",
      `样卡缺少必填字段：${missing.join("、")}（请在设置里补业务员联系方式后再打印）`,
      { missing },
    );
  }

  for (const [path, limit] of Object.entries(SAMPLE_CARD_LIMITS) as Array<
    [SampleCardFieldPath, number]
  >) {
    const value = values.scalars[path];
    if (value === null || value === undefined) continue;
    const text = String(value);
    const length = [...text].length;
    if (length > limit) {
      throw new PrintError(
        "PRINT_FIELD_OVERFLOW",
        `样卡字段超出版面：${PRINT_VARIABLES[path]} ${length} 字 > 上限 ${limit} 字`,
        { path, length, limit, value: text },
      );
    }
  }
}

/** 渲染 HTML 版式（A4）。与入队时使用的是同一个函数与同一份 values。 */
export function renderSampleCardHtml(body: string, values: TemplateValues): string {
  return renderTemplate(body, "SAMPLE_LABEL", values, { format: "HTML" });
}

/** 渲染标签指令（ZPL / TSPL）。 */
export function renderSampleCardText(
  body: string,
  values: TemplateValues,
  format: PrintTemplateFormat,
): string {
  if (format === "HTML") {
    throw new PrintError("PRINT_UNSUPPORTED_KIND", "HTML 版式不能当标签指令渲染");
  }
  return renderTemplate(body, "SAMPLE_LABEL", values, { format });
}

/** 二维码 PNG。内容只有公开页地址，不含价格与客户信息。 */
export function sampleCardQrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, {
    type: "png",
    width: 512,
    margin: 1,
    errorCorrectionLevel: "M",
  });
}

export async function sampleCardQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    width: 512,
    margin: 1,
    errorCorrectionLevel: "M",
  });
}

/**
 * 中文兜底字体（DroidSansFallback）里没有拉丁字母与数字的字形，
 * 如果整段用同一字体画，样品编号和电话会变成方框。
 * 因此按字符集切段：ASCII 用 PDF 内置 Helvetica（无需嵌入、任何阅读器都有），
 * 其余交给中文字体。这样离线环境也不会打出乱码卡。
 */
const LATIN_RUN = /[\x20-\x7e]+/g;

function runsOf(text: string): Array<{ latin: boolean; value: string }> {
  const runs: Array<{ latin: boolean; value: string }> = [];
  let last = 0;
  for (const match of text.matchAll(LATIN_RUN)) {
    const start = match.index ?? 0;
    if (start > last) runs.push({ latin: false, value: text.slice(last, start) });
    runs.push({ latin: true, value: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) runs.push({ latin: false, value: text.slice(last) });
  return runs;
}

function mixedWidth(text: string, size: number, cjk: PDFFont, latin: PDFFont): number {
  return runsOf(text).reduce(
    (sum, run) =>
      sum +
      (run.latin
        ? latin.widthOfTextAtSize(run.value, size)
        : cjk.widthOfTextAtSize(run.value, size)),
    0,
  );
}

function wrap(
  text: string,
  size: number,
  maxWidth: number,
  cjk: PDFFont,
  latin: PDFFont,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    if (mixedWidth(current + char, size, cjk, latin) <= maxWidth) {
      current += char;
      continue;
    }
    if (current) lines.push(current);
    current = char;
  }
  if (current) lines.push(current);
  return lines;
}

/** 按字符集切换字体绘制一段文字，返回绘制宽度。 */
function drawMixed(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  cjk: PDFFont,
  latin: PDFFont,
  color: ReturnType<typeof rgb>,
): number {
  let cursor = x;
  for (const run of runsOf(text)) {
    const font = run.latin ? latin : cjk;
    page.drawText(run.value, { x: cursor, y, size, font, color });
    cursor += font.widthOfTextAtSize(run.value, size);
  }
  return cursor - x;
}

/**
 * A4 样卡的内置版式（pdf-lib 直绘）。
 *
 * 有 Chromium 时优先用 HTML 模板（版式与预览完全一致）；没有浏览器的环境
 * 用这个兜底，保证「任何环境都打得出来」，且版面仍是样卡而不是订单表格。
 */
export async function renderBuiltinSampleCardPdf(source: SampleCardSource): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // 这个兜底字体做子集化会丢字（cmap 里的 CJK 映射保留不全），
  // 因此整份嵌入：一份样卡几十 KB 换「纸上每个字都对」。
  const font = await doc.embedFont(loadCjkFont(), { subset: false });
  const latin = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  const width = 595.28;
  const margin = 56;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.45, 0.5);
  const line = rgb(0.82, 0.84, 0.88);

  // 卡片框：A4 上半页，便于随手裁下随身带。
  const boxTop = 790;
  const boxBottom = 330;
  page.drawRectangle({
    x: margin,
    y: boxBottom,
    width: width - margin * 2,
    height: boxTop - boxBottom,
    borderColor: line,
    borderWidth: 1.5,
  });

  const text = (value: string, x: number, y: number, size: number, color = ink) =>
    drawMixed(page, value, x, y, size, font, latin, color);

  const left = margin + 24;
  const qrSize = 128;

  text(source.tenant.brand || source.tenant.name, left, boxTop - 44, 16);
  text("样卡 / SAMPLE CARD", left, boxTop - 66, 9, muted);

  text(source.sample.code, left, boxTop - 124, 38);
  text(source.sample.name, left, boxTop - 156, 15);

  const rows: Array<[string, string | null]> = [
    ["成分", source.sample.composition],
    ["克重", source.sample.weight],
    ["品类", source.sample.category],
    ["报价", source.quoteNo],
  ];
  let y = boxTop - 200;
  for (const [label, value] of rows) {
    if (!value) continue;
    text(label, left, y, 10, muted);
    const lines = wrap(value, 12, width - margin * 2 - 180, font, latin);
    lines.forEach((row, index) => {
      text(row, left + 52, y - index * 15, 12);
    });
    y -= 15 * Math.max(lines.length, 1) + 9;
  }

  // 二维码：与标签同一 payload，扫码结果一致。
  const qrPng = await doc.embedPng(await sampleCardQrPng(source.qrPayload));
  page.drawImage(qrPng, {
    x: width - margin - 32 - qrSize,
    y: boxBottom + 66,
    width: qrSize,
    height: qrSize,
  });

  text("联系业务员", left, boxBottom + 118, 9, muted);
  text(source.salesperson.name ?? "—", left, boxBottom + 98, 16);
  text(source.salesperson.phone ?? "—", left, boxBottom + 76, 13, muted);
  text("扫码只看样品编号与联系方式", left, boxBottom + 48, 8, muted);

  // 页脚：谁打的、什么时候打的、为什么补打——同一张卡也能回答这三问。
  const footer = [
    `打印时间 ${source.printedAt}`,
    `操作人 ${source.operator}`,
    source.reprintReason ? `补打原因 ${source.reprintReason}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("  |  ");
  text(footer, margin, 118, 8, muted);
  text("本卡不含价格与客户信息；样品问题请直接联系上方业务员。", margin, 100, 8, muted);

  return Buffer.from(await doc.save());
}

/**
 * A4 样卡 PDF：优先 Chromium 渲染同一份 HTML，失败/缺浏览器时用内置版式。
 * 与 `renderA4Pdf` 的区别在于兜底版式是样卡，而不是订单明细表。
 */
export async function renderSampleCardPdf(source: SampleCardSource, html: string): Promise<Buffer> {
  try {
    const rendered = await renderHtmlWithChrome(html);
    if (rendered && rendered.length > 1000) return rendered;
  } catch {
    // 浏览器不可用不影响出纸：内置版式是确定兜底。
  }
  return renderBuiltinSampleCardPdf(source);
}

/** 预览面板逐行展示的字段：与模板白名单同源，肉眼可对照纸上内容。 */
export function sampleCardPreviewFields(values: TemplateValues): PrintPreviewField[] {
  return (Object.keys(SAMPLE_CARD_LIMITS) as SampleCardFieldPath[])
    .map((path) => ({
      path,
      label: PRINT_VARIABLES[path],
      value:
        values.scalars[path] === null || values.scalars[path] === undefined
          ? ""
          : String(values.scalars[path]),
    }))
    .filter((field) => field.value.length > 0);
}
