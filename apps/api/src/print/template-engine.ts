import { PRINT_DOCUMENT_VARIABLES, PRINT_LOOPS, PRINT_VARIABLES } from "@weave-order/schema";
import type { PrintDocumentKind } from "@weave-order/schema";

export type PrintErrorCode =
  | "PRINT_TEMPLATE_UNKNOWN_VARIABLE"
  | "PRINT_TEMPLATE_SYNTAX"
  | "PRINT_TEMPLATE_UNKNOWN_LOOP"
  | "PRINT_MISSING_FIELD"
  | "PRINT_UNSUPPORTED_KIND"
  | "PRINT_QUANTITY_MISMATCH"
  | "PRINT_DISCREPANCY_UNRESOLVED"
  | "PRINT_REPRINT_REASON_REQUIRED"
  | "PRINT_TEMPLATE_NOT_FOUND"
  | "PRINT_AGENT_UNAUTHORIZED"
  | "PRINT_JOB_STATE_INVALID"
  | "PRINT_TEMPLATE_UNSAFE"
  | "PRINT_TEMPLATE_FORBIDDEN";

export class PrintError extends Error {
  constructor(
    readonly code: PrintErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PrintError";
  }
}

type Scalar = string | number | boolean | null;
type LoopRow = Record<string, Scalar>;

export interface TemplateValues {
  scalars: Record<string, Scalar>;
  loops: Record<string, LoopRow[]>;
}

interface TextNode {
  type: "text";
  value: string;
}
interface VarNode {
  type: "var";
  path: string;
}
interface LoopNode {
  type: "loop";
  name: string;
  inverted: boolean;
  children: TemplateNode[];
}
type TemplateNode = TextNode | VarNode | LoopNode;

export interface TemplateAnalysis {
  variables: string[];
  loops: string[];
}

function allowedScalars(kind: PrintDocumentKind): Set<string> {
  return new Set(PRINT_DOCUMENT_VARIABLES[kind]);
}

function allowedLoopRows(name: string): Set<string> | null {
  const rows = (PRINT_LOOPS as Record<string, readonly string[]>)[name];
  return rows ? new Set(rows) : null;
}

/**
 * 模板只允许 `{{path}}` 与 `{{#loop}}…{{/loop}}`：
 * 没有表达式、没有函数调用、没有查库——模板不能变成一段程序。
 */
export function parseTemplate(
  body: string,
  kind: PrintDocumentKind,
): { nodes: TemplateNode[]; analysis: TemplateAnalysis } {
  const scalarWhitelist = allowedScalars(kind);
  const variables = new Set<string>();
  const loops = new Set<string>();
  let index = 0;

  function parseNodes(inLoop: string | null): TemplateNode[] {
    const nodes: TemplateNode[] = [];
    while (index < body.length) {
      const open = body.indexOf("{{", index);
      if (open === -1) {
        nodes.push({ type: "text", value: body.slice(index) });
        index = body.length;
        break;
      }
      if (open > index) nodes.push({ type: "text", value: body.slice(index, open) });
      const close = body.indexOf("}}", open + 2);
      if (close === -1) {
        throw new PrintError("PRINT_TEMPLATE_SYNTAX", `模板在第 ${open} 个字符处的 {{ 没有闭合`);
      }
      const token = body.slice(open + 2, close).trim();
      index = close + 2;

      if (token.startsWith("#") || token.startsWith("^")) {
        const inverted = token.startsWith("^");
        const name = token.slice(1).trim();
        const loopWhitelist = allowedLoopRows(name);
        if (!loopWhitelist) {
          throw new PrintError("PRINT_TEMPLATE_UNKNOWN_LOOP", `模板引用了未注册的循环块：${name}`, {
            name,
          });
        }
        loops.add(name);
        const children = parseNodes(name);
        nodes.push({ type: "loop", name, inverted, children });
        continue;
      }
      if (token.startsWith("/")) {
        const name = token.slice(1).trim();
        if (inLoop === null) {
          throw new PrintError("PRINT_TEMPLATE_SYNTAX", `多余的循环结束标记：${token}`);
        }
        if (name !== inLoop) {
          throw new PrintError(
            "PRINT_TEMPLATE_SYNTAX",
            `循环结束标记不匹配：期望 {{/${inLoop}}}，实际 {{/${name}}}`,
          );
        }
        return nodes;
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(token)) {
        throw new PrintError("PRINT_TEMPLATE_SYNTAX", `模板变量只能写字段路径：{{${token}}}`);
      }
      if (inLoop) {
        const loopWhitelist = allowedLoopRows(inLoop);
        if (!loopWhitelist?.has(token)) {
          throw new PrintError(
            "PRINT_TEMPLATE_UNKNOWN_VARIABLE",
            `循环 {{${inLoop}}} 内不允许变量：${token}`,
            { variable: token, loop: inLoop },
          );
        }
      } else if (!scalarWhitelist.has(token)) {
        throw new PrintError(
          "PRINT_TEMPLATE_UNKNOWN_VARIABLE",
          `模板引用了未注册的变量：{{${token}}}（${kind} 白名单）`,
          { variable: token, kind },
        );
      }
      variables.add(token);
      nodes.push({ type: "var", path: token });
    }
    if (inLoop !== null) {
      throw new PrintError("PRINT_TEMPLATE_SYNTAX", `循环 {{#${inLoop}}} 没有闭合`);
    }
    return nodes;
  }

  const nodes = parseNodes(null);
  return { nodes, analysis: { variables: [...variables].sort(), loops: [...loops].sort() } };
}

/** 发布前校验：未知变量直接拒绝，并返回模板实际用到的变量供留痕。 */
export function analyzeTemplate(body: string, kind: PrintDocumentKind): TemplateAnalysis {
  return parseTemplate(body, kind).analysis;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function displayValue(value: Scalar): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function lookupScalar(values: TemplateValues, path: string): Scalar | undefined {
  if (path === "meta.missing") {
    const missing = values.scalars["meta.missing"];
    return missing;
  }
  return values.scalars[path];
}

/**
 * 渲染。引用到的字段为 null/undefined 时默认失败（不允许打印空值），
 * 只有显式 `allowMissing`（预览）才留空并在 meta.missing 里标黄。
 */
export function renderTemplate(
  body: string,
  kind: PrintDocumentKind,
  values: TemplateValues,
  options: { format: "HTML" | "ZPL" | "TSPL"; allowMissing?: boolean } = { format: "HTML" },
): string {
  const { nodes } = parseTemplate(body, kind);
  const missing = new Set<string>();
  const html = options.format === "HTML";

  function renderNodes(list: TemplateNode[], row: LoopRow | null): string {
    let out = "";
    for (const node of list) {
      if (node.type === "text") {
        out += node.value;
        continue;
      }
      if (node.type === "var") {
        const raw = row ? row[node.path] : lookupScalar(values, node.path);
        if (raw === undefined || raw === null) {
          missing.add(node.path);
          continue;
        }
        const text = displayValue(raw);
        out += html ? escapeHtml(text) : text;
        continue;
      }
      const rows = values.loops[node.name] ?? [];
      if (node.inverted) {
        out += rows.length === 0 ? renderNodes(node.children, null) : "";
        continue;
      }
      for (const item of rows) out += renderNodes(node.children, item);
    }
    return out;
  }

  const rendered = renderNodes(nodes, null);
  if (missing.size > 0 && !options.allowMissing) {
    throw new PrintError("PRINT_MISSING_FIELD", `模板缺少可打印字段：${[...missing].join(", ")}`, {
      missing: [...missing],
    });
  }
  return rendered;
}

/** 供文档视图构建器使用：把 DocumentView 拍平为模板可用的标量 + 循环行。 */
export function valuesFromDocumentView(view: {
  tenant: {
    name: string | null;
    brand?: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  customer: {
    name: string;
    contactName: string | null;
    phone: string | null;
    address: string | null;
  };
  order: {
    no: string;
    date: string;
    dueDate: string | null;
    currency: string;
  };
  shipment: {
    id: string;
    no: string;
    date: string;
    carrier: string | null;
    trackingNumber: string | null;
    address: string | null;
    boxCount: number;
    quantity: number;
  };
  boxes: Array<{
    boxNo: string;
    seq: number;
    qr: string;
    quantity: number;
    grossWeightKg: string | null;
  }>;
  lines: Array<{
    description: string;
    sampleCode: string | null;
    quantity: number;
    unit: string;
    unitPriceCents: number | null;
    lineTotalCents: number | null;
    location: string | null;
    lot: string | null;
  }>;
  totals: { quantity: number; currency: string; amountCents: number | null };
  meta: { printedAt: string; operator: string; reprintReason: string | null; missing: string[] };
  kind: string;
}): TemplateValues {
  return {
    scalars: {
      "tenant.name": view.tenant.name,
      "tenant.brand": view.tenant.brand || view.tenant.name || "—",
      "tenant.address": view.tenant.address,
      "tenant.phone": view.tenant.phone,
      "tenant.email": view.tenant.email,
      "customer.name": view.customer.name,
      "customer.contactName": view.customer.contactName ?? "—",
      "customer.phone": view.customer.phone ?? "—",
      "customer.address": view.customer.address ?? "—",
      "order.no": view.order.no,
      "order.date": view.order.date.slice(0, 10),
      "order.dueDate": view.order.dueDate ? view.order.dueDate.slice(0, 10) : "—",
      "order.currency": view.order.currency,
      "shipment.no": view.shipment.no,
      "shipment.date": view.shipment.date.slice(0, 10),
      "shipment.carrier": view.shipment.carrier ?? "—",
      "shipment.trackingNumber": view.shipment.trackingNumber ?? "—",
      "shipment.address": view.shipment.address,
      "shipment.boxCount": view.shipment.boxCount,
      "shipment.qty": view.shipment.quantity,
      "box.no": null,
      "box.seq": null,
      "box.qr": null,
      "box.count": null,
      "box.grossWeight": null,
      "box.size": null,
      "box.qty": null,
      "totals.amount": view.totals.amountCents,
      "totals.quantity": view.totals.quantity,
      "totals.currency": view.totals.currency,
      "meta.printedAt": view.meta.printedAt,
      "meta.operator": view.meta.operator,
      "meta.reprintReason": view.meta.reprintReason ?? "—",
      "meta.missing": view.meta.missing.join(", "),
    },
    loops: {
      lines: view.lines.map((line) => ({
        "line.description": line.description,
        "line.sampleCode": line.sampleCode ?? "—",
        "line.quantity": line.quantity,
        "line.unit": line.unit,
        "line.unitPrice": line.unitPriceCents,
        "line.lineTotal": line.lineTotalCents,
        "line.location": line.location ?? "—",
        "line.lot": line.lot ?? "—",
      })),
      boxes: view.boxes.map((box) => ({
        "box.no": box.boxNo,
        "box.seq": box.seq,
        "box.qr": box.qr,
        "box.qty": box.quantity,
        "box.grossWeight": box.grossWeightKg ?? "—",
      })),
    },
  };
}

/** 变量字典给 UI 的模板编辑器用。 */
export function templateVariableDictionary(kind: PrintDocumentKind) {
  return PRINT_DOCUMENT_VARIABLES[kind].map((path) => ({
    path,
    description: PRINT_VARIABLES[path],
  }));
}
