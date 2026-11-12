import { readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { QuoteDocumentSnapshot } from "@weave-order/schema";
import { formatCents } from "../kernel/money";

/**
 * 报价单 PDF 渲染（纯 JS，无系统级二进制）。
 *
 * 中文字形必须随文件走：这里内嵌 `assets/NotoSansSC-Subset.ttf`（Noto Sans SC
 * 子集，SIL OFL 1.1，见同目录 OFL.txt）。不依赖 headless Chrome / wkhtmltopdf /
 * 系统字体，容器里不需要装任何东西，导出的 PDF 在任何阅读器里显示一致。
 *
 * 版式全部绝对定位（A4，基线坐标），换行/截断由本文件显式控制：
 * 报价单是给客户看的文件，不能交给自动排版去猜。
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_RIGHT = MARGIN + CONTENT_WIDTH;
const BOTTOM_LIMIT = MARGIN + 56;

const ROW_HEIGHT = 22;
const TABLE_HEADER_HEIGHT = 24;
const DESC_WIDTH = CONTENT_WIDTH - 26 - 60 - 34 - 78 - 84;

const COLOR_TEXT = "#171b21";
const COLOR_MUTED = "#6b727a";
const COLOR_LINE = "#d6dbe0";
const COLOR_HEADER_BG = "#f2f4f6";

const FONT_NAME = "quote-cjk";

const UNIT_LABELS: Record<string, string> = {
  meter: "米",
  kilogram: "千克",
  yard: "码",
  piece: "件",
};

interface Column {
  x: number;
  width: number;
  align: "left" | "right" | "center";
}

const COLUMNS: Column[] = [
  { x: MARGIN, width: 26, align: "center" },
  { x: MARGIN + 26, width: DESC_WIDTH, align: "left" },
  { x: MARGIN + 26 + DESC_WIDTH, width: 60, align: "right" },
  { x: MARGIN + 26 + DESC_WIDTH + 60, width: 34, align: "center" },
  { x: MARGIN + 26 + DESC_WIDTH + 60 + 34, width: 78, align: "right" },
  { x: CONTENT_RIGHT - 84, width: 84, align: "right" },
];

const FONT_PATH = path.join(__dirname, "assets", "NotoSansSC-Subset.ttf");

/** 数量去掉无意义的小数零：500 -> "500"，12.500 -> "12.5"。 */
export function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

/**
 * 业务日期统一按东八区展示（报价有效期是「日子」，不是 UTC 时间点），
 * 手写偏移而不是依赖 Intl，保证任何运行时/时区下输出一致。
 */
export function formatCstDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function formatCstDateTime(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}

/** 单行放不下时按字符截断并加省略号（中文没有空格可断行）。 */
function fitText(doc: PDFKit.PDFDocument, text: string, size: number, maxWidth: number): string {
  doc.fontSize(size);
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = "…";
  const budget = maxWidth - doc.widthOfString(ellipsis);
  let out = "";
  for (const char of text) {
    if (doc.widthOfString(out + char) > budget) break;
    out += char;
  }
  return `${out}${ellipsis}`;
}

function wrapText(
  doc: PDFKit.PDFDocument,
  text: string,
  size: number,
  maxWidth: number,
): string[] {
  doc.fontSize(size);
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    if (doc.widthOfString(current + char) > maxWidth && current.length > 0) {
      lines.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * 本文件的版式用 PDF 原生坐标系（原点左下、y 向上）书写，和纸面一致；
 * PDFKit 用「原点左上、y 向下」，所以落笔前统一翻转一次。
 */
function toTopOrigin(y: number): number {
  return PAGE_HEIGHT - y;
}

/** 用基线坐标画一行文字；y 是基线，不是行盒顶端。 */
function drawText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  size: number,
  color = COLOR_TEXT,
): void {
  doc
    .font(FONT_NAME)
    .fontSize(size)
    .fillColor(color)
    .text(text, x, toTopOrigin(y), { baseline: "alphabetic", lineBreak: false });
}

function drawCell(
  doc: PDFKit.PDFDocument,
  text: string,
  column: Column,
  y: number,
  size: number,
  color = COLOR_TEXT,
): void {
  doc.fontSize(size);
  const width = doc.widthOfString(text);
  let x = column.x;
  if (column.align === "right") x = column.x + column.width - width;
  if (column.align === "center") x = column.x + (column.width - width) / 2;
  drawText(doc, text, x, y, size, color);
}

function rule(doc: PDFKit.PDFDocument, y: number, thickness = 0.8, color = COLOR_LINE): void {
  const top = toTopOrigin(y);
  doc
    .moveTo(MARGIN, top)
    .lineTo(CONTENT_RIGHT, top)
    .lineWidth(thickness)
    .strokeColor(color)
    .stroke();
}

function drawLetterhead(doc: PDFKit.PDFDocument, snapshot: QuoteDocumentSnapshot): number {
  const top = PAGE_HEIGHT - 56;
  drawText(doc, snapshot.company.name, MARGIN, top, 19);

  const contactLine =
    [snapshot.company.phone, snapshot.company.email].filter(Boolean).join("  ") || null;
  const metaLines = [snapshot.company.address, contactLine].filter(
    (line): line is string => line !== null && line.length > 0,
  );
  let metaY = top - 18;
  for (const line of metaLines.slice(0, 2)) {
    drawText(doc, fitText(doc, line, 8.5, CONTENT_WIDTH * 0.6), MARGIN, metaY, 8.5, COLOR_MUTED);
    metaY -= 12;
  }

  const title = "报价单";
  doc.fontSize(20);
  drawText(doc, title, CONTENT_RIGHT - doc.widthOfString(title), top, 20);
  const quoteNo = `编号 ${snapshot.quote.id.slice(0, 8).toUpperCase()}`;
  doc.fontSize(8.5);
  drawText(doc, quoteNo, CONTENT_RIGHT - doc.widthOfString(quoteNo), top - 22, 8.5, COLOR_MUTED);
  const issued = `出具日期 ${formatCstDate(snapshot.generatedAt)}`;
  doc.fontSize(8.5);
  drawText(doc, issued, CONTENT_RIGHT - doc.widthOfString(issued), top - 34, 8.5, COLOR_MUTED);

  const ruleY = Math.min(metaY, top - 44) - 6;
  rule(doc, ruleY, 1);
  return ruleY - 22;
}

function drawSlimHeader(doc: PDFKit.PDFDocument, snapshot: QuoteDocumentSnapshot): void {
  const y = PAGE_HEIGHT - 48;
  drawText(doc, snapshot.company.name, MARGIN, y, 10, COLOR_MUTED);
  const label = `报价单 · 编号 ${snapshot.quote.id.slice(0, 8).toUpperCase()}（续页）`;
  doc.fontSize(9);
  drawText(doc, label, CONTENT_RIGHT - doc.widthOfString(label), y, 9, COLOR_MUTED);
  rule(doc, y - 8, 0.8);
}

function drawCustomerBlock(
  doc: PDFKit.PDFDocument,
  snapshot: QuoteDocumentSnapshot,
  startY: number,
): number {
  let y = startY;
  const customer = snapshot.customer;
  drawText(doc, "致", MARGIN, y, 9, COLOR_MUTED);
  drawText(doc, customer.name, MARGIN + 22, y, 12);
  const codeLabel = `客户编号 ${customer.code}`;
  doc.fontSize(9);
  drawText(doc, codeLabel, CONTENT_RIGHT - doc.widthOfString(codeLabel), y, 9, COLOR_MUTED);
  y -= 16;

  const contact = [
    customer.contactName ? `联系人 ${customer.contactName}` : null,
    customer.contactPhone ? `电话 ${customer.contactPhone}` : null,
    customer.contactEmail ? `邮箱 ${customer.contactEmail}` : null,
  ].filter((part): part is string => part !== null);
  if (contact.length > 0) {
    drawText(doc, fitText(doc, contact.join("    "), 9, CONTENT_WIDTH), MARGIN, y, 9, COLOR_MUTED);
    y -= 14;
  }
  return y - 10;
}

function drawTableHeader(
  doc: PDFKit.PDFDocument,
  snapshot: QuoteDocumentSnapshot,
  y: number,
): number {
  const currency = snapshot.quote.currency;
  const headers = ["序", "品名", "数量", "单位", `单价 ${currency}`, `金额 ${currency}`];
  doc
    .rect(
      MARGIN,
      toTopOrigin(y + 6),
      CONTENT_WIDTH,
      TABLE_HEADER_HEIGHT,
    )
    .fill(COLOR_HEADER_BG);
  headers.forEach((header, index) => {
    const column = COLUMNS[index];
    if (!column) return;
    drawCell(doc, header, column, y - 6, 8.5, COLOR_MUTED);
  });
  return y - TABLE_HEADER_HEIGHT - 2;
}

function drawRow(
  doc: PDFKit.PDFDocument,
  snapshot: QuoteDocumentSnapshot,
  index: number,
  y: number,
): number {
  const line = snapshot.lines[index];
  if (!line) return y;
  const descColumn = COLUMNS[1];
  const cells = [
    String(index + 1),
    fitText(doc, line.description, 9.5, descColumn ? descColumn.width : 180),
    formatQuantity(line.quantity),
    unitLabel(line.unit),
    formatCents(line.unitPriceCents),
    formatCents(line.lineTotalCents),
  ];
  cells.forEach((cell, cellIndex) => {
    const column = COLUMNS[cellIndex];
    if (!column) return;
    drawCell(doc, cell, column, y, cellIndex === 1 ? 9.5 : 9);
  });
  rule(doc, y - 7, 0.5);
  return y - ROW_HEIGHT;
}

function drawClosing(
  doc: PDFKit.PDFDocument,
  snapshot: QuoteDocumentSnapshot,
  startY: number,
): number {
  const currency = snapshot.quote.currency;
  const totalText = formatCents(snapshot.quote.totalCents);
  const subtotalText = formatCents(snapshot.quote.subtotalCents);

  drawText(doc, "小计", CONTENT_RIGHT - 150, startY - 6, 9, COLOR_MUTED);
  doc.fontSize(9);
  drawText(doc, subtotalText, CONTENT_RIGHT - doc.widthOfString(subtotalText), startY - 6, 9);

  drawText(doc, "合计", CONTENT_RIGHT - 150, startY - 26, 11);
  const totalLine = `${currency} ${totalText}`;
  doc.fontSize(11);
  drawText(doc, totalLine, CONTENT_RIGHT - doc.widthOfString(totalLine), startY - 26, 11);

  const validity = `有效期：${snapshot.quote.validityDays} 天，至 ${formatCstDate(
    snapshot.quote.expiresAt,
  )}`;
  drawText(doc, validity, MARGIN, startY - 6, 9);

  if (snapshot.quote.confirmedAt) {
    const confirmed = `确认：${snapshot.quote.confirmedBy ?? "-"} · ${formatCstDateTime(
      snapshot.quote.confirmedAt,
    )}`;
    drawText(doc, confirmed, MARGIN, startY - 22, 8.5, COLOR_MUTED);
  }

  let y = startY - 46;
  rule(doc, y + 6, 0.8);

  if (snapshot.terms.length > 0) {
    drawText(doc, "条款", MARGIN, y, 9, COLOR_MUTED);
    y -= 14;
    snapshot.terms.forEach((term, index) => {
      for (const text of wrapText(doc, `${index + 1}. ${term}`, 8.5, CONTENT_WIDTH)) {
        if (y < BOTTOM_LIMIT) return;
        drawText(doc, text, MARGIN, y, 8.5);
        y -= 12;
      }
    });
  }

  if (snapshot.quote.remarks) {
    y -= 6;
    drawText(doc, "备注", MARGIN, y, 9, COLOR_MUTED);
    y -= 14;
    for (const text of wrapText(doc, snapshot.quote.remarks, 8.5, CONTENT_WIDTH)) {
      if (y < BOTTOM_LIMIT) break;
      drawText(doc, text, MARGIN, y, 8.5);
      y -= 12;
    }
  }
  return y;
}

/**
 * 渲染一份客户可直接转发的报价单。
 * 输入只有内容快照：同样的快照永远渲染出同样的版式内容。
 */
export async function renderQuotePdf(snapshot: QuoteDocumentSnapshot): Promise<Uint8Array> {
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margin: 0,
    // 页脚要写「第 x / y 页」，必须先缓冲所有页面再回填。
    bufferPages: true,
    info: {
      Title: `报价单 ${snapshot.customer.name} ${snapshot.quote.id.slice(0, 8)}`,
      Author: snapshot.company.name,
      Creator: "WeaveOrder",
      Producer: "WeaveOrder",
    },
  });
  doc.registerFont(FONT_NAME, readFileSync(FONT_PATH));

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", reject);
  });

  let y = drawLetterhead(doc, snapshot);
  y = drawCustomerBlock(doc, snapshot, y);
  y = drawTableHeader(doc, snapshot, y);

  for (let index = 0; index < snapshot.lines.length; index += 1) {
    if (y - ROW_HEIGHT < BOTTOM_LIMIT) {
      doc.addPage({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 0 });
      drawSlimHeader(doc, snapshot);
      y = drawTableHeader(doc, snapshot, PAGE_HEIGHT - 78);
    }
    y = drawRow(doc, snapshot, index, y);
  }

  if (y < BOTTOM_LIMIT + 170) {
    doc.addPage({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 0 });
    drawSlimHeader(doc, snapshot);
    y = PAGE_HEIGHT - 90;
  }
  drawClosing(doc, snapshot, y);

  // 页码在全部页面生成后再写：需要知道总页数。
  const pageRange = doc.bufferedPageRange();
  const pageCount = pageRange.count;
  for (let index = 0; index < pageCount; index += 1) {
    doc.switchToPage(pageRange.start + index);
    const footer = `本报价单由 WeaveOrder 生成 · ${formatCstDateTime(
      snapshot.generatedAt,
    )}（东八区）`;
    drawText(doc, footer, MARGIN, MARGIN - 14, 7.5, COLOR_MUTED);
    const pageLabel = `第 ${index + 1} / ${pageCount} 页`;
    doc.fontSize(7.5);
    drawText(doc, pageLabel, CONTENT_RIGHT - doc.widthOfString(pageLabel), MARGIN - 14, 7.5, COLOR_MUTED);
  }

  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

/** 文件下载名：用 ASCII，避免不同浏览器对中文文件名的编码差异。 */
export function quotePdfFilename(snapshot: QuoteDocumentSnapshot): string {
  const code = snapshot.customer.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "customer";
  return `quotation-${code}-${snapshot.quote.id.slice(0, 8)}.pdf`;
}
