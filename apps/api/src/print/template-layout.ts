import { PRINT_DOCUMENT_VARIABLES } from "@weave-order/schema";
import type {
  PrintDocumentKind,
  PrintTemplateFormat,
  PrintTemplateLayout,
} from "@weave-order/schema";
import { PrintError } from "./template-engine";
import type { TemplateValues } from "./template-engine";

/**
 * 版式编译（P0c）。
 *
 * 编辑器只产出「一行一个字段」的结构化版式，真正落库的仍然是模板正文：
 * 这里把版式编译成 HTML / ZPL / TSPL，再交给已有的模板引擎与打印流水线。
 * 因此可视化编辑不会绕开白名单——编译结果还会再过一遍 `analyzeTemplate`。
 */

/** 二维码图片字段只能出现在 qr 块里；当成文字打印没有意义，也容易被误当正文。 */
const QR_ONLY_FIELDS = new Set(["card.qrImage", "box.qr", "card.qr"]);

/** 默认样卡版式（A4）：与系统内置 A4 样卡对应，用户从这份开始改。 */
export const DEFAULT_SAMPLE_CARD_LAYOUT: PrintTemplateLayout = {
  version: 1,
  blocks: [
    { field: "tenant.brand", label: null, visible: true, fontSize: 16, bold: true },
    { field: "sample.code", label: null, visible: true, fontSize: 26, bold: true },
    { field: "sample.name", label: null, visible: true, fontSize: 18, bold: false },
    { field: "sample.composition", label: "成分", visible: true, fontSize: 12, bold: false },
    { field: "sample.weight", label: "克重", visible: true, fontSize: 12, bold: false },
    { field: "sample.category", label: "品类", visible: true, fontSize: 12, bold: false },
    { field: "salesperson.name", label: "业务员", visible: true, fontSize: 14, bold: false },
    { field: "salesperson.phone", label: null, visible: true, fontSize: 14, bold: false },
    { field: "meta.printedAt", label: "打印时间", visible: true, fontSize: 10, bold: false },
  ],
  qr: { visible: true, position: "RIGHT", sizeMm: 30 },
};

/**
 * 默认样卡版式（80×50mm 标签）：纸上只能放六七行，因此默认就去掉品类与打印时间。
 * 版式是按毫米算的，A4 和热敏标签共用一套字号必然撑爆 400 点高度。
 */
export const DEFAULT_SAMPLE_CARD_LABEL_LAYOUT: PrintTemplateLayout = {
  version: 1,
  blocks: [
    { field: "tenant.brand", label: null, visible: true, fontSize: 9, bold: true },
    { field: "sample.code", label: null, visible: true, fontSize: 14, bold: true },
    { field: "sample.name", label: null, visible: true, fontSize: 10, bold: false },
    { field: "sample.composition", label: "成分", visible: true, fontSize: 8, bold: false },
    { field: "sample.weight", label: "克重", visible: true, fontSize: 8, bold: false },
    { field: "salesperson.name", label: "业务员", visible: true, fontSize: 8, bold: false },
    { field: "salesperson.phone", label: null, visible: true, fontSize: 8, bold: false },
  ],
  qr: { visible: true, position: "RIGHT", sizeMm: 26 },
};

/** 按版面取默认版式。 */
export function defaultLayoutFor(format: PrintTemplateFormat): PrintTemplateLayout {
  return format === "HTML" ? DEFAULT_SAMPLE_CARD_LAYOUT : DEFAULT_SAMPLE_CARD_LABEL_LAYOUT;
}

/** 可视化编辑器当前支持的单据类型：样卡（P0c 的范围，其它单据继续走文本模板）。 */
export const LAYOUT_EDITABLE_KINDS: PrintDocumentKind[] = ["SAMPLE_LABEL"];

export function isLayoutEditable(kind: PrintDocumentKind): boolean {
  return LAYOUT_EDITABLE_KINDS.includes(kind);
}

/** 白名单校验：字段必须属于该单据类型，且二维码字段不能当文字行。 */
export function assertLayoutAllowed(layout: PrintTemplateLayout, kind: PrintDocumentKind): void {
  const allowed = new Set<string>(PRINT_DOCUMENT_VARIABLES[kind]);
  for (const block of layout.blocks) {
    if (!allowed.has(block.field)) {
      throw new PrintError(
        "PRINT_TEMPLATE_UNKNOWN_VARIABLE",
        `版式里引用了该单据不支持的字段：${block.field}`,
        { variable: block.field, kind },
      );
    }
    if (QR_ONLY_FIELDS.has(block.field)) {
      throw new PrintError(
        "PRINT_TEMPLATE_UNKNOWN_VARIABLE",
        `二维码字段不能当文字行：${block.field}，请用「二维码」区块`,
        { variable: block.field, kind },
      );
    }
  }
}

/**
 * 标签指令里的静态文字不能带指令/分隔字符，否则一个标签名就能改写指令结构。
 * ZPL 用 `^`/`~` 起新指令；TSPL 的 TEXT 参数以逗号分隔、以引号包裹字符串，
 * 因此 `"` 与 `,` 都能提前闭合字符串。
 *
 * 同一份版式会同时编译出 HTML / ZPL / TSPL 三种正文，行标签只有一份字符串，
 * 所以这里按最严格的机型（TSPL）统一清洗：ZPL 也一并去掉逗号。
 * 想按机型分开清洗，就得把行标签变成 format 的函数，代价是三种正文的标签文字可能不一致。
 */
function sanitizeStaticText(value: string): string {
  // 两机型共用：换行/制表符会把一条指令拆成两条；`^`/`~` 会起新 ZPL 指令。
  const base = value.replace(/[\r\n\t]+/g, " ").replace(/\^|~/g, " ");
  // TSPL 最严格：引号与逗号是参数语法，直接去掉；反斜杠不做转义猜测。ZPL 也沿用。
  return base
    .replace(/["\\,]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

interface PlannedLine {
  /** 已去掉指令字符的前缀（如「成分 」）；值由模板引擎按变量替换。 */
  label: string;
  field: string;
  /** 标签格式使用的点阵字号（203dpi）。 */
  dots: number;
  fontSize: number;
  bold: boolean;
}

function plannedLines(layout: PrintTemplateLayout): PlannedLine[] {
  return layout.blocks
    .filter((block) => block.visible)
    .map((block) => ({
      label: block.label ? `${sanitizeStaticText(block.label)} ` : "",
      field: block.field,
      // 1pt ≈ 2 点（203dpi 下 1pt = 2.82 点，取 2 让默认字号落在标签可读区间）。
      dots: Math.max(12, Math.min(72, Math.round(block.fontSize * 2))),
      fontSize: block.fontSize,
      bold: block.bold,
    }));
}

const LABEL_WIDTH = 640;
const LABEL_HEIGHT = 400;
const LABEL_MARGIN = 20;
/** 左侧从 20 点起排，右侧再留 10 点安全边：热敏机轻微偏移不会把字切在纸边。 */
const PRINTABLE_WIDTH = LABEL_WIDTH - LABEL_MARGIN - 10;
const DOTS_PER_MM = 8;

/**
 * 按「最坏载荷 ≈ Version 12（65 模块）」估算 QR 的模块数。
 * 载荷是公开页地址，长度受 32 字节样品编号 token 限制，不会无限增长；
 * 预留 65 模块后，二维码的物理尺寸接近用户设置的 sizeMm。
 */
const QR_MODULES = 65;

function qrMagnification(sizeMm: number): number {
  return Math.max(1, Math.min(10, Math.round((sizeMm * DOTS_PER_MM) / QR_MODULES)));
}

function qrSquareDots(sizeMm: number): number {
  return QR_MODULES * qrMagnification(sizeMm);
}

/**
 * 二维码横向位置：左右贴边各留安全边，上下位置居中。
 * 旧实现无论 LEFT/RIGHT/TOP/BOTTOM 都用固定 380 点，大尺寸二维码会被切掉右侧。
 */
function qrLeft(position: PrintTemplateLayout["qr"]["position"], qrDots: number): number {
  if (position === "LEFT") return LABEL_MARGIN;
  if (position === "RIGHT") return LABEL_WIDTH - LABEL_MARGIN - qrDots;
  return Math.round((LABEL_WIDTH - qrDots) / 2);
}

function assertQrFits(sizeMm: number): void {
  const dots = qrSquareDots(sizeMm);
  if (dots > PRINTABLE_WIDTH) {
    throw new PrintError(
      "PRINT_LAYOUT_OVERFLOW",
      `二维码尺寸超出 80×50 标签：${sizeMm}mm 约 ${dots} 点 > 可用 ${PRINTABLE_WIDTH} 点`,
      { sizeMm, width: dots, limit: PRINTABLE_WIDTH },
    );
  }
}

/**
 * 估算一行文字的物理宽度（点）：ASCII 约 0.6 字宽，中文/全角约 1 字宽。
 * 不是精确排版，只用来在发布前拦住「小标签 + 大字号」这类必然出界的版式。
 */
function estimateTextDots(text: string, dots: number): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code >= 0x20 && code <= 0x7e ? dots * 0.6 : dots;
  }
  return width;
}

/**
 * 80×50 标签是固定画布：纵向溢出已由画布高度兜住，横向此前没人管。
 * 发布阶段只能确定「行标签」的宽度（业务值要到打印时才知道），
 * 因此这里先拦住写得太长的静态标签；业务值的宽度由 `assertSampleCardDataFits`
 * 在渲染前按真实数据校验。
 */
function assertLinesFit(lines: PlannedLine[]): void {
  for (const line of lines) {
    const width = estimateTextDots(line.label, line.dots);
    if (width > PRINTABLE_WIDTH) {
      throw new PrintError(
        "PRINT_LAYOUT_OVERFLOW",
        `版式横向超出 80×50 标签：字段 ${line.field} 的行标签约 ${Math.round(width)} 点 > 可用 ${PRINTABLE_WIDTH} 点（缩短标签或调小字号）`,
        { field: line.field, width: Math.round(width), limit: PRINTABLE_WIDTH },
      );
    }
  }
}

/** 二维码在左右两侧时，正文只能用到剩下的那一栏。 */
function textBox(layout: PrintTemplateLayout): { x: number; width: number } {
  if (!layout.qr.visible) return { x: LABEL_MARGIN, width: PRINTABLE_WIDTH };
  const qrDots = qrSquareDots(layout.qr.sizeMm);
  const qrX = qrLeft(layout.qr.position, qrDots);
  if (layout.qr.position === "LEFT") {
    return { x: LABEL_MARGIN + qrDots + 8, width: PRINTABLE_WIDTH - qrDots - 8 };
  }
  if (layout.qr.position === "RIGHT") {
    return { x: LABEL_MARGIN, width: qrX - 8 - LABEL_MARGIN };
  }
  return { x: LABEL_MARGIN, width: PRINTABLE_WIDTH };
}

/**
 * 用真实数据校验标签版式。
 *
 * 发布时的宽度校验只能按字段上限估算；真正打印时才知道值有多长。
 * 二维码贴在左右两侧时，正文与二维码共用同一片纸宽——值太长会压到二维码上，
 * 扫码可能因此失败。这里在渲染前按实际值拦一次，给出可执行的修复建议。
 */
export function assertSampleCardDataFits(
  layout: PrintTemplateLayout,
  values: TemplateValues,
): void {
  const box = textBox(layout);
  for (const line of plannedLines(layout)) {
    const value = values.scalars[line.field];
    if (value === null || value === undefined) continue;
    const width = estimateTextDots(`${line.label}${String(value)}`, line.dots);
    if (width <= box.width) continue;
    throw new PrintError(
      "PRINT_LAYOUT_OVERFLOW",
      `标签放不下：${line.field} 与其他内容需要约 ${Math.round(width)} 点，可用 ${Math.round(box.width)} 点（缩短内容、调小字号，或把二维码移到上下）`,
      { field: line.field, width: Math.round(width), limit: Math.round(box.width) },
    );
  }
}

function compileHtml(layout: PrintTemplateLayout, kind: PrintDocumentKind): string {
  const mainRows = plannedLines(layout)
    .map((line) => {
      const size = `font-size:${line.fontSize}pt;`;
      const weight = line.bold ? "font-weight:700;" : "";
      if (line.label) {
        return `      <tr><th style="${size}${weight}">${line.label.trim()}</th><td style="${size}${weight}">{{${line.field}}}</td></tr>`;
      }
      return `      <tr><td colspan="2" style="${size}${weight}">{{${line.field}}}</td></tr>`;
    })
    .join("\n");

  const qrField = kind === "SAMPLE_LABEL" ? "card.qrImage" : "box.qr";
  const qrBlock = layout.qr.visible
    ? `      <div class="qr"><img src="{{${qrField}}}" alt="二维码" style="width:${layout.qr.sizeMm}mm;height:${layout.qr.sizeMm}mm"><div class="hint">扫码查看</div></div>`
    : "";
  const qrFirst = layout.qr.position === "TOP" || layout.qr.position === "LEFT";
  const qrInline = layout.qr.position === "LEFT" || layout.qr.position === "RIGHT";

  const body = qrInline
    ? `    <div class="split${qrFirst ? " reverse" : ""}">
      <div class="main">
        <table>
${mainRows}
        </table>
      </div>
${qrBlock}
    </div>`
    : `    <div class="stack">
${qrFirst ? qrBlock : ""}
      <table>
${mainRows}
      </table>
${qrFirst ? "" : qrBlock}
    </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 12mm; }
  body { margin: 0; font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif; color: #111827; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; width: 26mm; color: #6b7280; font-weight: 500; padding: 1.6mm 0; border-bottom: 1px dotted #d7dbe1; vertical-align: top; white-space: nowrap; }
  td { padding: 1.6mm 0; border-bottom: 1px dotted #d7dbe1; vertical-align: top; }
  .split { display: flex; gap: 8mm; align-items: flex-start; }
  .split.reverse { flex-direction: row-reverse; }
  .main { flex: 1; min-width: 0; }
  .qr { text-align: center; }
  .qr img { display: block; }
  .hint { font-size: 8pt; color: #9ca3af; margin-top: 1mm; }
  </style></head><body>
${body}
</body></html>`;
}

function compileZpl(layout: PrintTemplateLayout): string {
  const lines = plannedLines(layout);
  assertLinesFit(lines);
  assertQrFits(layout.qr.sizeMm);
  const position = layout.qr.position;
  const qrInline = position === "LEFT" || position === "RIGHT";
  const qrHeight = qrSquareDots(layout.qr.sizeMm);
  const qrSide = qrLeft(position, qrHeight);
  // 二维码在左侧时正文必须让出这一栏，否则每一行都压在二维码上。
  const textX = textBox(layout).x;
  let y = LABEL_MARGIN;
  const commands: string[] = ["^XA", `^PW${LABEL_WIDTH}`, `^LL${LABEL_HEIGHT}`, "^CI28"];
  let qrBottom = 0;

  const qrCommand = (top: number) => {
    qrBottom = Math.max(qrBottom, top + qrHeight);
    return `^FO${qrSide},${top}^BQN,2,${qrMagnification(layout.qr.sizeMm)}^FDMA,{{card.qr}}^FS`;
  };

  if (layout.qr.visible && (qrInline || position === "TOP")) {
    commands.push(qrCommand(LABEL_MARGIN));
    if (!qrInline) y = qrBottom + 8;
  }
  for (const line of lines) {
    commands.push(
      `^FO${textX},${y}^A0N,${line.dots},${line.dots}^FD${line.label}{{${line.field}}}^FS`,
    );
    y += line.dots + 8;
  }
  if (layout.qr.visible && position === "BOTTOM") commands.push(qrCommand(y));
  const used = Math.max(y, qrBottom);
  if (used > LABEL_HEIGHT) {
    throw new PrintError(
      "PRINT_LAYOUT_OVERFLOW",
      `版式超出 80×50 标签（需要 ${used} 点 > ${LABEL_HEIGHT} 点）：隐藏几行或调小字号`,
      { height: used, limit: LABEL_HEIGHT },
    );
  }
  commands.push("^XZ");
  return commands.join("\n");
}

function tsplFont(dots: number): string {
  if (dots >= 24) return "TSS24.BF2";
  if (dots >= 16) return "TSS16.BF2";
  return "TSS12.BF2";
}

function compileTspl(layout: PrintTemplateLayout): string {
  const lines = plannedLines(layout);
  assertLinesFit(lines);
  assertQrFits(layout.qr.sizeMm);
  const position = layout.qr.position;
  const qrInline = position === "LEFT" || position === "RIGHT";
  const cell = qrMagnification(layout.qr.sizeMm);
  const qrHeight = qrSquareDots(layout.qr.sizeMm);
  const qrX = qrLeft(position, qrHeight);
  const textX = textBox(layout).x;
  let y = LABEL_MARGIN;
  let qrBottom = 0;
  const commands: string[] = ["SIZE 80 mm,50 mm", "GAP 2 mm,0 mm", "DIRECTION 1", "CLS"];
  const qrCommand = (top: number) => {
    qrBottom = Math.max(qrBottom, top + qrHeight);
    return `QRCODE ${qrX},${top},L,${cell},A,0,"{{card.qr}}"`;
  };

  if (layout.qr.visible && (qrInline || position === "TOP")) {
    commands.push(qrCommand(LABEL_MARGIN));
    if (!qrInline) y = qrBottom + 8;
  }
  for (const line of lines) {
    commands.push(
      `TEXT ${textX},${y},"${tsplFont(line.dots)}",0,1,1,"${line.label}{{${line.field}}}"`,
    );
    y += line.dots + 8;
  }
  if (layout.qr.visible && position === "BOTTOM") commands.push(qrCommand(y));
  const used = Math.max(y, qrBottom);
  if (used > LABEL_HEIGHT) {
    throw new PrintError(
      "PRINT_LAYOUT_OVERFLOW",
      `版式超出 80×50 标签（需要 ${used} 点 > ${LABEL_HEIGHT} 点）：隐藏几行或调小字号`,
      { height: used, limit: LABEL_HEIGHT },
    );
  }
  commands.push("PRINT 1,1");
  return commands.join("\n");
}

export interface CompiledLayout {
  body: string;
  pageSize: string;
}

/** 版式 → 模板正文。字段合法性在这里先挡一次，编译结果随后还会过白名单解析。 */
export function compileLayout(
  layout: PrintTemplateLayout,
  kind: PrintDocumentKind,
  format: PrintTemplateFormat,
): CompiledLayout {
  assertLayoutAllowed(layout, kind);
  if (format === "HTML") return { body: compileHtml(layout, kind), pageSize: "A4" };
  if (format === "ZPL") return { body: compileZpl(layout), pageSize: "80x50" };
  return { body: compileTspl(layout), pageSize: "80x50" };
}
