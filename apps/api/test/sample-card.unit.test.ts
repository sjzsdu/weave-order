import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { PRINT_DOCUMENT_VARIABLES, PRINT_VARIABLES } from "@weave-order/schema";
import {
  SAMPLE_CARD_LIMITS,
  assertSampleCardPdfLayout,
  assertSampleCardPrintable,
  assertSampleCodeFitsToken,
  renderBuiltinSampleCardPdf,
  renderSampleCardHtml,
  renderSampleCardText,
  sampleCardQrPng,
  sampleCardValues,
} from "../src/print/sample-card";
import type { SampleCardSource } from "../src/print/sample-card";
import { analyzeTemplate, PrintError } from "../src/print/template-engine";
import { SYSTEM_TEMPLATES } from "../src/print/templates";
import {
  buildSampleCardUrl,
  createSampleCardToken,
  parseSampleCardToken,
} from "../src/kernel/share-token";

/**
 * P0b 样卡的纯函数测试：
 * 1) 字段缺失/超长必须显式报错（不截断）；
 * 2) 内置模板必须只引用白名单变量（否则发布校验会拒）；
 * 3) 二维码只承载「样品编号 + 业务员」这条公开链接。
 */

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "test-sample-card-secret-32-bytes-long";

const token = createSampleCardToken({ tenantId: TENANT_ID, sampleCode: "FM-220" }, SECRET);
const qrPayload = buildSampleCardUrl("https://quote.example.com", token);

const source: SampleCardSource = {
  quoteNo: "BJ-20261120-8A3F",
  sample: {
    code: "FM-220",
    name: "32S 精梳棉汗布",
    composition: "100% 棉",
    weight: "220g/m2",
    category: "汗布",
  },
  tenant: { name: "织序纺织", brand: "织序 WEAVE" },
  salesperson: { name: "孙巨中", phone: "13800000000" },
  qrPayload,
  qrImageDataUrl: "data:image/png;base64,AAAA",
  printedAt: "2026-11-20T12:00:00.000Z",
  operator: "owner",
  reprintReason: null,
};

function builtin(kind: "SAMPLE_LABEL", format: "HTML" | "ZPL" | "TSPL") {
  const template = SYSTEM_TEMPLATES.find((item) => item.kind === kind && item.format === format);
  if (!template) throw new Error(`缺少内置模板 ${kind}/${format}`);
  return template;
}

describe("样卡二维码 token", () => {
  it("签名 token 能还原租户与样品编号", () => {
    expect(parseSampleCardToken(token, SECRET)).toMatchObject({ t: TENANT_ID, c: "FM-220" });
  });

  it("改一个字符就失效", () => {
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(parseSampleCardToken(tampered, SECRET)).toBeNull();
    expect(parseSampleCardToken(token, `${SECRET}-other`)).toBeNull();
  });

  it("二维码内容是公开页地址，且不含价格/客户名", () => {
    expect(qrPayload).toBe(`https://quote.example.com/s/sample/${token}`);
    expect(qrPayload).not.toContain("BJ-");
    expect(qrPayload).not.toContain("青禾");
    expect(qrPayload).not.toMatch(/\d+\.\d{2}/);
  });
});

describe("样卡字段校验", () => {
  it("缺业务员电话时显式报错，而不是打一张找不到人的卡", () => {
    const values = sampleCardValues({ ...source, salesperson: { name: "孙巨中", phone: null } });
    try {
      assertSampleCardPrintable(values);
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintError);
      expect((error as PrintError).code).toBe("PRINT_MISSING_FIELD");
      expect(((error as PrintError).detail.missing as string[]).join(",")).toContain(
        "salesperson.phone",
      );
    }
  });

  it("字段超出版面时显式报错，并给出长度与上限", () => {
    const longName = "超长样品名称".repeat(6);
    const values = sampleCardValues({
      ...source,
      sample: { ...source.sample, name: longName },
    });
    try {
      assertSampleCardPrintable(values);
      throw new Error("应当抛错");
    } catch (error) {
      expect((error as PrintError).code).toBe("PRINT_FIELD_OVERFLOW");
      expect((error as PrintError).detail).toMatchObject({
        path: "sample.name",
        length: [...longName].length,
        limit: SAMPLE_CARD_LIMITS["sample.name"],
      });
    }
  });

  it("中文样品编号超 32 字节时给出业务错误，而不是让 token 抛裸 Error", () => {
    // 12 个字符合法（≤32 字符），但 36 字节超出二维码 token 容量。
    const code = "真丝面料真丝面料真丝面料";
    expect([...code].length).toBe(12);
    try {
      assertSampleCodeFitsToken(code);
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintError);
      expect((error as PrintError).code).toBe("PRINT_FIELD_OVERFLOW");
      expect((error as PrintError).detail).toMatchObject({ path: "sample.code", limit: 32 });
    }
    // 整卡校验同样拦住它：preview/打印都会走这一步。
    const values = sampleCardValues({ ...source, sample: { ...source.sample, code } });
    let fullError: unknown;
    try {
      assertSampleCardPrintable(values);
    } catch (error) {
      fullError = error;
    }
    expect((fullError as PrintError).code).toBe("PRINT_FIELD_OVERFLOW");
  });

  it("33 个字符与 32 个字符的 ASCII 编号分别拒绝与放行", () => {
    expect(() => assertSampleCodeFitsToken("A".repeat(32))).not.toThrow();
    let codeError: unknown;
    try {
      assertSampleCodeFitsToken("A".repeat(33));
    } catch (error) {
      codeError = error;
    }
    expect((codeError as PrintError).code).toBe("PRINT_FIELD_OVERFLOW");

    const longValues = sampleCardValues({
      ...source,
      sample: { ...source.sample, code: "A".repeat(33) },
    });
    let valuesError: unknown;
    try {
      assertSampleCardPrintable(longValues);
    } catch (error) {
      valuesError = error;
    }
    expect((valuesError as PrintError).code).toBe("PRINT_FIELD_OVERFLOW");
  });

  it("可选字段缺失降级为短横线，不阻塞打印", () => {
    const values = sampleCardValues({
      ...source,
      sample: { ...source.sample, composition: null, weight: null, category: null },
    });
    expect(() => assertSampleCardPrintable(values)).not.toThrow();
    expect(values.scalars["sample.composition"]).toBe("—");
  });
});

describe("内置样卡模板", () => {
  it("A4 / ZPL / TSPL 三套模板都只引用白名单变量", () => {
    for (const format of ["HTML", "ZPL", "TSPL"] as const) {
      const template = builtin("SAMPLE_LABEL", format);
      expect(() => analyzeTemplate(template.body, "SAMPLE_LABEL")).not.toThrow();
    }
  });

  it("A4 版式渲染出样卡内容并转义，不截断", () => {
    const template = builtin("SAMPLE_LABEL", "HTML");
    const html = renderSampleCardHtml(template.body, sampleCardValues(source));
    expect(html).toContain("FM-220");
    expect(html).toContain("32S 精梳棉汗布");
    expect(html).toContain("孙巨中");
    expect(html).toContain("13800000000");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain("客户");
  });

  it("标签指令带二维码命令与 80×50 尺寸", () => {
    const values = sampleCardValues(source);
    const zpl = renderSampleCardText(builtin("SAMPLE_LABEL", "ZPL").body, values, "ZPL");
    expect(zpl).toContain("^PW640");
    expect(zpl).toContain("^LL400");
    expect(zpl).toContain(`^BQN,2,5^FDMA,${qrPayload}`);
    expect(zpl).toContain("FM-220");

    const tspl = renderSampleCardText(builtin("SAMPLE_LABEL", "TSPL").body, values, "TSPL");
    expect(tspl).toContain("SIZE 80 mm,50 mm");
    expect(tspl).toContain(`QRCODE 20,150,L,5,A,0,"${qrPayload}"`);
  });

  it("样卡白名单里没有客户、价格类变量", () => {
    const paths = PRINT_DOCUMENT_VARIABLES.SAMPLE_LABEL;
    expect(paths.some((path) => path.startsWith("customer."))).toBe(false);
    expect(paths.some((path) => path.includes("price") || path.includes("amount"))).toBe(false);
    for (const path of paths) {
      expect(PRINT_VARIABLES[path]).toBeTruthy();
    }
  });
});

describe("样卡二维码图片与 A4 兜底版式", () => {
  it("二维码可生成 PNG", async () => {
    const png = await sampleCardQrPng(qrPayload);
    expect(png.subarray(1, 4).toString("utf8")).toBe("PNG");
  });

  it("没有浏览器时也能生成 A4 样卡 PDF（不是订单表格）", async () => {
    const pdf = await renderBuiltinSampleCardPdf(source);
    expect(pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it("A4 样卡 PDF 是单页、页面尺寸就是 A4", async () => {
    const pdf = await renderBuiltinSampleCardPdf(source);
    await expect(assertSampleCardPdfLayout(pdf)).resolves.toBeUndefined();
  });

  it("渲染器给成 Letter 或两页时显式报错，而不是拿去打印", async () => {
    const letter = await PDFDocument.create();
    letter.addPage([612, 792]);
    await expect(assertSampleCardPdfLayout(Buffer.from(await letter.save()))).rejects.toMatchObject(
      { code: "PRINT_PAGE_SIZE_MISMATCH" },
    );

    const twoPages = await PDFDocument.create();
    twoPages.addPage([595.28, 841.89]);
    twoPages.addPage([595.28, 841.89]);
    await expect(
      assertSampleCardPdfLayout(Buffer.from(await twoPages.save())),
    ).rejects.toMatchObject({ code: "PRINT_PAGE_SIZE_MISMATCH" });
  });
});
