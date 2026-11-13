import type { DocumentView, OrderBox, PrintTemplateFormat } from "@weave-order/schema";
import { builtinTemplate } from "./templates";
import { PrintError, renderTemplate, valuesFromDocumentView } from "./template-engine";
import type { TemplateValues } from "./template-engine";
import { boxView } from "./qr";

function applyBox(values: TemplateValues, view: DocumentView, box: OrderBox): TemplateValues {
  return {
    scalars: {
      ...values.scalars,
      "box.no": box.boxNo,
      "box.seq": box.seq,
      "box.qr": box.qr,
      "box.count": view.shipment.boxCount,
      "box.grossWeight": box.grossWeightKg,
      "box.size": box.size,
      "box.qty": box.quantity,
    },
    loops: values.loops,
  };
}

/**
 * 标签渲染：ZPL/TSPL 都是纯文本指令，二维码由打印机指令生成，
 * 不依赖打印机内置字体里的条码能力（中文仍需要打印机装载 CJK 字体）。
 */
export function renderBoxLabel(input: {
  view: DocumentView;
  box: OrderBox;
  body: string;
  format: PrintTemplateFormat;
  reprintReason: DocumentView["meta"]["reprintReason"];
}): string {
  const scoped = boxView(input.view, { ...input.box, qr: input.box.qr });
  const view: DocumentView = {
    ...scoped,
    meta: { ...scoped.meta, reprintReason: input.reprintReason },
  };
  const values = applyBox(valuesFromDocumentView(view), view, input.box);
  return renderTemplate(input.body, "BOX_LABEL", values, {
    format: input.format === "TSPL" ? "TSPL" : "ZPL",
  });
}

export function renderTestLabel(input: {
  view: DocumentView;
  format: PrintTemplateFormat;
  body?: string;
}): string {
  const template = input.body
    ? { body: input.body, format: input.format }
    : builtinTemplate("TEST_LABEL", input.format);
  if (!template) {
    throw new PrintError("PRINT_TEMPLATE_NOT_FOUND", `没有 ${input.format} 格式的测试标签模板`);
  }
  const first = input.view.boxes[0];
  const box: OrderBox = {
    id: input.view.shipment.id,
    shipmentId: input.view.shipment.id,
    boxNo: first?.boxNo ?? "TEST-01",
    seq: first?.seq ?? 1,
    qr: first?.qr ?? `${input.view.tenant.name}/TEST/1`,
    status: "OPEN",
    quantity: first?.quantity ?? 0,
    items: [],
    grossWeightKg: null,
    size: null,
    note: null,
    hasDiscrepancy: false,
    verifiedAt: null,
    printedAt: null,
    printCount: 0,
    createdAt: input.view.meta.printedAt,
  };
  const values = applyBox(valuesFromDocumentView(input.view), input.view, box);
  return renderTemplate(template.body, "TEST_LABEL", values, {
    format: input.format === "TSPL" ? "TSPL" : "ZPL",
  });
}
