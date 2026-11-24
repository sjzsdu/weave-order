import { describe, expect, it } from "vitest";
import type { PrintTemplateLayout } from "@weave-order/schema";
import { analyzeTemplate, PrintError, renderTemplate } from "../src/kernel/print/template-engine";
import {
  assertLayoutAllowed,
  assertSampleCardDataFits,
  buildLabelPreview,
  compileLayout,
  DEFAULT_SAMPLE_CARD_LABEL_LAYOUT,
  DEFAULT_SAMPLE_CARD_LAYOUT,
} from "../src/kernel/print/template-layout";

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

const previewValues = {
  scalars: {
    "tenant.brand": "织序 WEAVE",
    "sample.code": "FM-220",
    "sample.name": "32S 精梳棉汗布",
    "sample.composition": "100% 棉",
    "sample.weight": "220 g/m²",
    "salesperson.name": "孙巨中",
    "salesperson.phone": "13800000000",
    "meta.printedAt": "2026-11-23 15:00",
    "card.qrImage": "data:image/png;base64,AAAA",
  },
  loops: {},
};

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

  it("TSPL 行首标签里的引号/逗号被清掉，不能提前闭合 TEXT 字符串", () => {
    const compiled = compileLayout(
      layoutWith([
        {
          field: "sample.code",
          label: 'a","0,1,1,"X',
          visible: true,
          fontSize: 12,
          bold: false,
        },
      ]),
      "SAMPLE_LABEL",
      "TSPL",
    );
    const line = compiled.body.split("\n").find((item) => item.includes("{{sample.code}}"))!;
    expect(line).not.toContain('a","0,1,1,"X');
    // 合法形态：TEXT x,y,"字体",0,1,1,"标签 {{field}}" —— 整行只有 4 个引号。
    expect(line.match(/"/g) ?? []).toHaveLength(4);
  });

  it("行标签只有一份字符串：逗号在 ZPL 里也按 TSPL 的严格规则去掉", () => {
    const layout = layoutWith([
      { field: "sample.code", label: "成分,克重", visible: true, fontSize: 12, bold: false },
    ]);
    const expectedSuffix = { ZPL: "^FD成分 克重 ", TSPL: '"成分 克重 ' } as const;
    for (const format of ["ZPL", "TSPL"] as const) {
      const line = compileLayout(layout, "SAMPLE_LABEL", format)
        .body.split("\n")
        .find((item) => item.includes("{{sample.code}}"))!;
      const labelPrefix = line.split("{{sample.code}}")[0]!;
      expect(labelPrefix.endsWith(expectedSuffix[format])).toBe(true);
    }
  });

  it("标签数据值也不能带指令字符：ZPL 去 ^/~，TSPL 去引号", () => {
    const zpl = renderTemplate(
      "^FD{{sample.name}}^FS",
      "SAMPLE_LABEL",
      { scalars: { "sample.name": "真丝^XA~HS面料" }, loops: {} },
      { format: "ZPL" },
    );
    expect(zpl).toBe("^FD真丝 XA HS面料^FS");

    const tspl = renderTemplate(
      'TEXT 10,10,"TSS16.BF2",0,1,1,"{{sample.name}}"',
      "SAMPLE_LABEL",
      {
        scalars: { "sample.name": 'He said "hi"' },
        loops: {},
      },
      { format: "TSPL" },
    );
    expect(tspl).toBe('TEXT 10,10,"TSS16.BF2",0,1,1,"He said \'hi\'"');
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

  it("默认 80×50 版式的每一行与二维码都落在 640×400 画布内", () => {
    const zpl = compileLayout(DEFAULT_SAMPLE_CARD_LABEL_LAYOUT, "SAMPLE_LABEL", "ZPL").body;
    for (const line of zpl.split("\n")) {
      const fo = line.match(/^\^FO(\d+),(\d+)/);
      if (!fo) continue;
      expect(Number(fo[1])).toBeGreaterThanOrEqual(20);
      expect(Number(fo[1])).toBeLessThan(640);
      expect(Number(fo[2])).toBeLessThan(400);
    }

    const tspl = compileLayout(DEFAULT_SAMPLE_CARD_LABEL_LAYOUT, "SAMPLE_LABEL", "TSPL").body;
    for (const line of tspl.split("\n")) {
      const at = line.match(/^(?:TEXT|QRCODE) (\d+),(\d+)/);
      if (!at) continue;
      expect(Number(at[1])).toBeGreaterThanOrEqual(20);
      expect(Number(at[1])).toBeLessThan(640);
      expect(Number(at[2])).toBeLessThan(400);
    }
  });

  it("静态行标签写太长时，发布阶段就拒绝而不是打半张卡", () => {
    const longLabel = "成分".repeat(16);
    expect(() =>
      compileLayout(
        layoutWith([
          { field: "sample.name", label: longLabel, visible: true, fontSize: 24, bold: false },
        ]),
        "SAMPLE_LABEL",
        "ZPL",
      ),
    ).toThrowError(/行标签约/);
    expect(() =>
      compileLayout(
        layoutWith([
          { field: "sample.name", label: longLabel, visible: true, fontSize: 24, bold: false },
        ]),
        "SAMPLE_LABEL",
        "TSPL",
      ),
    ).toThrowError(/行标签约/);
  });

  it("二维码尺寸超出画布时拒绝；上下位置改为居中", () => {
    expect(() =>
      compileLayout(
        { ...layoutWith([]), qr: { visible: true, position: "RIGHT", sizeMm: 200 } },
        "SAMPLE_LABEL",
        "ZPL",
      ),
    ).toThrowError(/二维码尺寸超出/);

    const bottom = compileLayout(
      {
        ...layoutWith([
          { field: "sample.code", label: null, visible: true, fontSize: 12, bold: false },
        ]),
        qr: { visible: true, position: "BOTTOM", sizeMm: 26 },
      },
      "SAMPLE_LABEL",
      "ZPL",
    ).body;
    const qrLine = bottom.split("\n").find((line) => line.includes("^BQN"))!;
    const x = Number(qrLine.match(/^\^FO(\d+)/)![1]);
    // 26mm → mag 3 → 65×3=195 点，居中 x=(640-195)/2≈222。
    expect(x).toBeGreaterThan(200);
    expect(x + 195).toBeLessThan(640);
  });

  it("侧边二维码给正文让位；左侧二维码时正文整体右移", () => {
    const left = compileLayout(
      {
        ...layoutWith([
          { field: "sample.code", label: null, visible: true, fontSize: 12, bold: false },
        ]),
        qr: { visible: true, position: "LEFT", sizeMm: 26 },
      },
      "SAMPLE_LABEL",
      "ZPL",
    ).body;
    const textLine = left.split("\n").find((line) => line.includes("{{sample.code}}"))!;
    const x = Number(textLine.match(/^\^FO(\d+)/)![1]);
    // 左二维码 26mm → 195 点 + 8 点间距：正文从 223 点起。
    expect(x).toBe(223);
  });

  it("按真实数据校验：常见值放得下，长样品名不会压到右侧二维码", () => {
    const scalars = {
      "tenant.brand": "织序 WEAVE",
      "sample.code": "FM-220",
      "sample.name": "32S 精梳棉汗布",
      "sample.composition": "100% 棉",
      "sample.weight": "220g/m2",
      "salesperson.name": "孙巨中",
      "salesperson.phone": "13800000000",
    };
    expect(() =>
      assertSampleCardDataFits(DEFAULT_SAMPLE_CARD_LABEL_LAYOUT, { scalars, loops: {} }),
    ).not.toThrow();

    expect(() =>
      assertSampleCardDataFits(DEFAULT_SAMPLE_CARD_LABEL_LAYOUT, {
        scalars: { ...scalars, "sample.name": "超长样品名称".repeat(4) },
        loops: {},
      }),
    ).toThrowError(/标签放不下/);
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

  it("labelPreview 与 ZPL/TSPL 共用布局计划，字段、坐标、字号和二维码一致", () => {
    for (const format of ["ZPL", "TSPL"] as const) {
      const compiled = compileLayout(DEFAULT_SAMPLE_CARD_LABEL_LAYOUT, "SAMPLE_LABEL", format);
      const preview = buildLabelPreview({
        layout: DEFAULT_SAMPLE_CARD_LABEL_LAYOUT,
        isSystem: false,
        format,
        values: previewValues,
      });
      expect(preview).toMatchObject({ width: 640, height: 400 });
      expect(preview?.elements[0]).toEqual({
        type: "qr",
        x: 425,
        y: 20,
        size: 195,
        dataUrl: "data:image/png;base64,AAAA",
      });
      expect(preview?.elements[1]).toEqual({
        type: "text",
        x: 20,
        y: 20,
        text: "织序 WEAVE",
        fontSize: 18,
        bold: true,
      });
      expect(preview?.elements[2]).toMatchObject({
        type: "text",
        x: 20,
        y: 46,
        text: "FM-220",
        fontSize: 28,
      });
      expect(compiled.body).toContain(format === "ZPL" ? "^FO20,20" : "TEXT 20,20");
      expect(compiled.body).toContain(format === "ZPL" ? "^FO20,46" : "TEXT 20,46");
      expect(compiled.body).toContain(format === "ZPL" ? "^FO425,20" : "QRCODE 425,20");
    }
  });

  it("系统内置 ZPL/TSPL 标签按固定指令坐标生成图元", () => {
    const zpl = buildLabelPreview({
      layout: null,
      isSystem: true,
      format: "ZPL",
      values: previewValues,
    });
    expect(zpl?.elements).toContainEqual({
      type: "rect",
      x: 24,
      y: 44,
      width: 592,
      height: 2,
    });
    expect(zpl?.elements).toContainEqual({
      type: "text",
      x: 24,
      y: 52,
      text: "FM-220",
      fontSize: 30,
      bold: false,
    });
    expect(zpl?.elements).toContainEqual({
      type: "qr",
      x: 24,
      y: 150,
      size: 185,
      dataUrl: "data:image/png;base64,AAAA",
    });

    const tspl = buildLabelPreview({
      layout: null,
      isSystem: true,
      format: "TSPL",
      values: previewValues,
    });
    expect(tspl?.elements).toContainEqual({
      type: "rect",
      x: 20,
      y: 36,
      width: 580,
      height: 2,
    });
    expect(tspl?.elements).toContainEqual({
      type: "text",
      x: 20,
      y: 44,
      text: "FM-220",
      fontSize: 24,
      bold: false,
    });
    expect(tspl?.elements).toContainEqual({
      type: "qr",
      x: 20,
      y: 150,
      size: 185,
      dataUrl: "data:image/png;base64,AAAA",
    });
  });

  it("HTML/A4 与无 layout 的手写模板不伪造 labelPreview", () => {
    expect(
      buildLabelPreview({
        layout: DEFAULT_SAMPLE_CARD_LAYOUT,
        isSystem: false,
        format: "HTML",
        values: previewValues,
      }),
    ).toBeNull();
    expect(
      buildLabelPreview({
        layout: null,
        isSystem: false,
        format: "ZPL",
        values: previewValues,
      }),
    ).toBeNull();
  });
});
