import { describe, expect, it } from "vitest";
import type { PrintTemplateLayout } from "@weave-order/schema";
import { analyzeTemplate, PrintError, renderTemplate } from "../src/print/template-engine";
import {
  assertLayoutAllowed,
  compileLayout,
  DEFAULT_SAMPLE_CARD_LABEL_LAYOUT,
  DEFAULT_SAMPLE_CARD_LAYOUT,
} from "../src/print/template-layout";

/**
 * P0c 版式编译：编辑器产出的版式必须先过白名单，再编译成真的模板正文。
 * 这里盯的是三条底线：
 * 1. 版式只能引用该单据类型的白名单字段；
 * 2. 编译产物仍然能被模板引擎解析（不留绕过白名单的缝）；
 * 3. 用户填的静态文字不能把 ZPL/TSPL 指令注入进标签。
 */

function layoutWith(blocks: PrintTemplateLayout["blocks"]): PrintTemplateLayout {
  return { version: 1, blocks, qr: { visible: false, position: "RIGHT", sizeMm: 30 } };
}

describe("样卡版式编译", () => {
  it("默认版式编译成 A4 HTML：只出现白名单字段，二维码用图片字段", () => {
    const compiled = compileLayout(DEFAULT_SAMPLE_CARD_LAYOUT, "SAMPLE_LABEL", "HTML");
    expect(compiled.pageSize).toBe("A4");
    expect(compiled.body).toContain("{{sample.code}}");
    expect(compiled.body).toContain("{{salesperson.phone}}");
    expect(compiled.body).toContain("{{card.qrImage}}");

    const analysis = analyzeTemplate(compiled.body, "SAMPLE_LABEL");
    expect(analysis.loops).toEqual([]);
    expect(analysis.variables).toContain("sample.code");
    expect(analysis.variables).toContain("card.qrImage");
  });

  it("字号与显隐进入编译结果：隐藏的行不出现在正文里", () => {
    const compiled = compileLayout(
      layoutWith([
        { field: "sample.code", label: null, visible: true, fontSize: 26, bold: true },
        { field: "sample.name", label: null, visible: false, fontSize: 18, bold: false },
      ]),
      "SAMPLE_LABEL",
      "HTML",
    );
    expect(compiled.body).toContain("font-size:26pt");
    expect(compiled.body).toContain("font-weight:700");
    expect(compiled.body).not.toContain("{{sample.name}}");
  });

  it("版式里出现非样卡字段时，编译阶段就拒绝并指出字段名", () => {
    expect(() =>
      compileLayout(
        layoutWith([{ field: "order.no", label: null, visible: true, fontSize: 14, bold: false }]),
        "SAMPLE_LABEL",
        "HTML",
      ),
    ).toThrowError(/order\.no/);
  });

  it("二维码字段不能当文字行：否则整段二维码内容会被打成一行乱码", () => {
    expect(() =>
      assertLayoutAllowed(
        layoutWith([{ field: "card.qr", label: null, visible: true, fontSize: 12, bold: false }]),
        "SAMPLE_LABEL",
      ),
    ).toThrowError(/二维码/);
  });

  it("行首标签里的 ZPL/TSPL 指令字符被清掉，不能靠标签名注入命令", () => {
    const compiled = compileLayout(
      layoutWith([
        { field: "sample.code", label: "^XA~HS", visible: true, fontSize: 12, bold: false },
      ]),
      "SAMPLE_LABEL",
      "ZPL",
    );
    const labelLine = compiled.body
      .split("\n")
      .filter((line) => line.includes("{{sample.code}}"))
      .join("\n");
    expect(labelLine).not.toContain("^XA");
    expect(labelLine).not.toContain("~");
  });

  it("80×50 标签放不下时显式报错，而不是打一张被截断的卡", () => {
    const blocks = Array.from({ length: 12 }, () => ({
      field: "sample.name",
      label: null,
      visible: true,
      fontSize: 40,
      bold: false,
    }));
    expect(() => compileLayout(layoutWith(blocks), "SAMPLE_LABEL", "ZPL")).toThrowError(PrintError);
  });

  it("ZPL/TSPL 产物都是可下发的指令流，二维码走 card.qr", () => {
    const zpl = compileLayout(DEFAULT_SAMPLE_CARD_LABEL_LAYOUT, "SAMPLE_LABEL", "ZPL");
    expect(zpl.body.startsWith("^XA")).toBe(true);
    expect(zpl.body.trim().endsWith("^XZ")).toBe(true);
    expect(zpl.body).toContain("{{card.qr}}");

    const tspl = compileLayout(DEFAULT_SAMPLE_CARD_LABEL_LAYOUT, "SAMPLE_LABEL", "TSPL");
    expect(tspl.body).toContain("SIZE 80 mm,50 mm");
    expect(tspl.body).toContain("PRINT 1,1");
    expect(tspl.body).toContain("{{card.qr}}");
  });

  it("编译产物可以用真实数据渲染：HTML 转义、标签不转义", () => {
    const html = compileLayout(
      layoutWith([{ field: "sample.name", label: null, visible: true, fontSize: 18, bold: false }]),
      "SAMPLE_LABEL",
      "HTML",
    ).body;
    const values = {
      scalars: { "sample.name": "真丝 <b>面料</b>" },
      loops: {},
    };
    const rendered = renderTemplate(html, "SAMPLE_LABEL", values, { format: "HTML" });
    expect(rendered).toContain("&lt;b&gt;");
    expect(rendered).not.toContain("<b>面料</b>");
  });
});
