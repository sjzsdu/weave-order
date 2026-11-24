import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentView } from "@weave-order/schema";
import { sanitizeHtmlForPrint } from "./html-safety";
import { PrintError } from "./template-engine";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 40;

const FONT_CANDIDATES = [
  process.env.PRINT_CJK_FONT_PATH,
  path.join(__dirname, "..", "..", "..", "assets", "fonts", "DroidSansFallbackFull.ttf"),
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
].filter((candidate): candidate is string => Boolean(candidate));

let cachedFont: Buffer | null = null;

export function loadCjkFont(): Buffer {
  if (cachedFont) return cachedFont;
  for (const candidate of FONT_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedFont = readFileSync(candidate);
      return cachedFont;
    }
  }
  throw new PrintError(
    "PRINT_TEMPLATE_NOT_FOUND",
    "服务端 PDF 缺少中文正文字体：请设置 PRINT_CJK_FONT_PATH 指向一个 TTF/OTF（TTC 不支持）",
  );
}

/** 简易按宽度折行：中文按字符、英文按单词；高度不足时由调用方换页。 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    const next = current + char;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = char;
  }
  if (current) lines.push(current);
  return lines;
}

function money(cents: number | null, currency: string): string {
  if (cents === null) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * 内置 A4 版式：分页表格 + 页眉页脚。
 * 自定义 HTML 模板优先走 Chromium（若部署了 PRINT_CHROME_PATH），
 * 否则用这个内置版式兜底，保证「任何环境都打得出来」。
 */
export async function renderBuiltinA4Pdf(view: DocumentView): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadCjkFont(), { subset: true });
  const pageSize: [number, number] = [A4_WIDTH, A4_HEIGHT];

  let page: PDFPage = doc.addPage(pageSize);
  let y = A4_HEIGHT - MARGIN;
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.42, 0.45, 0.5);
  const line = rgb(0.85, 0.87, 0.9);

  const text = (
    value: string,
    x: number,
    size: number,
    opts: { color?: ReturnType<typeof rgb>; maxWidth?: number } = {},
  ) => {
    page.drawText(value, {
      x,
      y,
      size,
      font,
      color: opts.color ?? ink,
      maxWidth: opts.maxWidth,
    });
  };

  const newPage = () => {
    page = doc.addPage(pageSize);
    y = A4_HEIGHT - MARGIN;
  };

  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 24) newPage();
  };

  // 页眉
  text(view.tenant.name || "—", MARGIN, 18);
  y -= 24;
  const brand = (view.tenant as { brand?: string | null }).brand;
  if (brand) {
    text(brand, MARGIN, 9, { color: muted });
    y -= 14;
  }
  text(view.title, MARGIN, 14);
  const printed = `打印 ${view.meta.printedAt.slice(0, 16).replace("T", " ")} · ${view.meta.operator}`;
  page.drawText(printed, {
    x: A4_WIDTH - MARGIN - font.widthOfTextAtSize(printed, 8),
    y: A4_HEIGHT - MARGIN - 8,
    size: 8,
    font,
    color: muted,
  });
  y -= 18;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: A4_WIDTH - MARGIN, y },
    thickness: 1.2,
    color: ink,
  });
  y -= 18;

  // 元信息两列
  const meta: Array<[string, string]> = [
    ["订单号", view.order.no],
    ["客户", view.customer.name],
    ["发货单", view.shipment.no],
    ["发货日期", view.shipment.date.slice(0, 10)],
    ["箱数", String(view.shipment.boxCount)],
    ["承运商", view.shipment.carrier ?? "—"],
    ["收货地址", view.shipment.address ?? view.customer.address ?? "—"],
    ["运单号", view.shipment.trackingNumber ?? "—"],
  ];
  for (let i = 0; i < meta.length; i += 2) {
    const pair = meta.slice(i, i + 2);
    for (const [index, [label, value]] of pair.entries()) {
      const x = MARGIN + index * 260;
      page.drawText(label, { x, y, size: 8, font, color: muted });
      const wrapped = wrap(value, font, 9, 190);
      page.drawText(wrapped[0] ?? "", { x: x + 54, y, size: 9, font, color: ink });
    }
    y -= 16;
  }
  y -= 8;

  // 表头
  const columns = [
    { title: "品名", width: 215 },
    { title: "数量", width: 55 },
    { title: "单位", width: 40 },
    { title: "单价", width: 80 },
    { title: "金额", width: 85 },
  ];
  const drawHeader = () => {
    page.drawRectangle({
      x: MARGIN,
      y: y - 6,
      width: A4_WIDTH - MARGIN * 2,
      height: 18,
      color: rgb(0.95, 0.96, 0.97),
    });
    let x = MARGIN + 6;
    for (const column of columns) {
      page.drawText(column.title, { x, y, size: 8, font, color: muted });
      x += column.width;
    }
    y -= 18;
  };
  drawHeader();

  for (const item of view.lines) {
    ensure(30);
    const description = wrap(item.description, font, 9, columns[0]!.width - 8);
    const rowHeight = Math.max(description.length * 12, 14);
    let x = MARGIN + 6;
    description.forEach((part, index) => {
      page.drawText(part, { x, y: y - index * 12, size: 9, font, color: ink });
    });
    x += columns[0]!.width;
    page.drawText(String(item.quantity), { x, y, size: 9, font, color: ink });
    x += columns[1]!.width;
    page.drawText(item.unit, { x, y, size: 9, font, color: ink });
    x += columns[2]!.width;
    page.drawText(money(item.unitPriceCents, view.order.currency), {
      x,
      y,
      size: 9,
      font,
      color: ink,
    });
    x += columns[3]!.width;
    page.drawText(money(item.lineTotalCents, view.order.currency), {
      x,
      y,
      size: 9,
      font,
      color: ink,
    });
    y -= rowHeight + 4;
    page.drawLine({
      start: { x: MARGIN, y: y + 4 },
      end: { x: A4_WIDTH - MARGIN, y: y + 4 },
      thickness: 0.4,
      color: line,
    });
  }

  if (view.lines.length === 0) {
    page.drawText("没有明细", { x: MARGIN + 6, y, size: 9, font, color: muted });
    y -= 18;
  }

  ensure(50);
  y -= 8;
  const totals = [
    `合计数量 ${view.totals.quantity}`,
    view.totals.amountCents !== null
      ? `合计金额 ${money(view.totals.amountCents, view.totals.currency)}`
      : null,
    `箱数 ${view.shipment.boxCount}`,
  ].filter((value): value is string => Boolean(value));
  const totalsLine = totals.join("    ");
  page.drawText(totalsLine, {
    x: A4_WIDTH - MARGIN - font.widthOfTextAtSize(totalsLine, 10),
    y,
    size: 10,
    font,
    color: ink,
  });
  y -= 22;

  if (view.boxes.length > 0 && view.kind !== "BOX_LABEL") {
    ensure(28);
    const boxLine = view.boxes
      .map(
        (box) =>
          `${box.boxNo}(${box.quantity}${box.grossWeightKg ? `,${box.grossWeightKg}kg` : ""})`,
      )
      .join("  ");
    for (const part of wrap(`箱号：${boxLine}`, font, 8, A4_WIDTH - MARGIN * 2)) {
      page.drawText(part, { x: MARGIN, y, size: 8, font, color: muted });
      y -= 11;
    }
  }

  if (view.meta.missing.length > 0) {
    ensure(20);
    page.drawText(`缺字段：${view.meta.missing.join(", ")}`, {
      x: MARGIN,
      y,
      size: 8,
      font,
      color: rgb(0.7, 0.45, 0.05),
    });
  }

  const pages = doc.getPages();
  pages.forEach((item, index) => {
    const footer = `${view.tenant.name} · ${index + 1}/${pages.length}`;
    item.drawText(footer, {
      x: MARGIN,
      y: 24,
      size: 7,
      font,
      color: muted,
    });
  });

  return Buffer.from(await doc.save());
}

function chromePath(): string | null {
  // 只认显式配置：不自动探测系统 Chrome，避免开发机/CI 上误触发
  // 几十秒级的 headless 渲染，且保证渲染路径可预期。
  const configured = process.env.PRINT_CHROME_PATH;
  return configured && existsSync(configured) ? configured : null;
}

/**
 * headless Chromium 的渲染参数。
 *
 * 模板正文来自成员，渲染进程必须假设它可能带脚本或远程资源：
 *   - `--blink-settings=scriptEnabled=false` + `--disable-javascript` 关掉 JS；
 *   - `--host-resolver-rules=MAP * ~NOTFOUND` 让所有域名解析失败，
 *     即便有残留的远程 img/iframe 也连不出去（防内网 / 云元数据探测）。
 * 单独导出便于离线断言「参数没有被改回去」。
 */
export function chromePrintArgs(htmlPath: string, pdfPath: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-javascript",
    "--blink-settings=scriptEnabled=false",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-client-side-phishing-detection",
    "--disable-remote-fonts",
    "--no-pings",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ];
}

/** HTML → PDF：仅在部署了 Chromium 时启用；否则返回 null 走内置版式。 */
export async function renderHtmlWithChrome(html: string): Promise<Buffer | null> {
  const chrome = chromePath();
  if (!chrome) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "weave-print-"));
  const htmlPath = path.join(dir, "document.html");
  const pdfPath = path.join(dir, "document.pdf");
  try {
    // 发布时已拒绝危险模板；这里再洗一遍，覆盖历史上已入库的模板。
    await writeFile(htmlPath, sanitizeHtmlForPrint(html), "utf8");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(chrome, chromePrintArgs(htmlPath, pdfPath), { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Chromium 渲染超时"));
      }, 10_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Chromium 退出码 ${code ?? "unknown"}`));
      });
    });
    return await readFile(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 统一入口：优先 Chromium，失败/缺失时内置版式；不会因为「没装浏览器」打不出纸。 */
export async function renderA4Pdf(view: DocumentView, html: string): Promise<Buffer> {
  try {
    const rendered = await renderHtmlWithChrome(html);
    if (rendered && rendered.length > 1000) return rendered;
  } catch {
    // 浏览器渲染失败不阻断打印：内置版式是确定的兜底。
  }
  return renderBuiltinA4Pdf(view);
}
