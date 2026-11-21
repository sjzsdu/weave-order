import { describe, expect, it } from "vitest";
import { renderBoxLabel } from "../src/print/labels";
import { renderBuiltinA4Pdf } from "../src/print/pdf";
import { buildBoxQr, parseBoxQr } from "../src/print/qr";
import { analyzeTemplate, PrintError, renderTemplate } from "../src/print/template-engine";
import type { DocumentView, OrderBox } from "@weave-order/schema";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const SHIPMENT_ID = "33333333-3333-4333-8333-333333333333";

const view: DocumentView = {
  kind: "BOX_LABEL",
  title: "箱唛",
  locale: "zh-CN",
  tenant: {
    name: "织序纺织",
    contactName: null,
    phone: "0571-88886666",
    email: "hi@weave.test",
    address: "杭州市滨江区",
  },
  customer: {
    name: "青禾服饰",
    contactName: "周敏",
    phone: "13800000000",
    email: null,
    address: "绍兴市柯桥区",
  },
  order: {
    id: ORDER_ID,
    no: "WO-2026-001",
    date: "2026-11-01T00:00:00.000Z",
    dueDate: "2026-11-20T00:00:00.000Z",
    currency: "CNY",
  },
  shipment: {
    id: SHIPMENT_ID,
    no: "SH-33333333",
    date: "2026-11-12T00:00:00.000Z",
    carrier: "顺丰",
    trackingNumber: "SF123",
    address: "绍兴市柯桥区创意路 8 号",
    boxCount: 2,
    quantity: 100,
  },
  lines: [
    {
      position: 0,
      description: "32S 精梳棉汗布",
      sampleCode: "FM-220",
      quantity: 100,
      unit: "meter",
      unitPriceCents: 1500,
      lineTotalCents: 150000,
      location: null,
      lot: null,
    },
  ],
  boxes: [
    {
      boxNo: "BOX-01",
      seq: 1,
      qr: buildBoxQr({ tenantId: TENANT_ID, orderId: ORDER_ID, boxNo: "BOX-01", seq: 1 }),
      quantity: 50,
      itemCount: 1,
      grossWeightKg: null,
      size: "60x40x40",
    },
  ],
  totals: { quantity: 100, currency: "CNY", amountCents: 150000 },
  meta: {
    printedAt: "2026-11-12T08:00:00.000Z",
    operator: "owner",
    reprintReason: null,
    missing: [],
  },
};

const box: OrderBox = {
  id: "44444444-4444-4444-8444-444444444444",
  shipmentId: SHIPMENT_ID,
  boxNo: "BOX-01",
  seq: 1,
  qr: view.boxes[0]!.qr,
  status: "OPEN",
  quantity: 50,
  items: [
    {
      shipmentItemId: "55555555-5555-4555-8555-555555555555",
      orderItemId: "66666666-6666-4666-8666-666666666666",
      description: "32S 精梳棉汗布",
      quantity: 50,
      unit: "meter",
    },
  ],
  grossWeightKg: null,
  size: null,
  note: null,
  hasDiscrepancy: false,
  verifiedAt: null,
  printedAt: null,
  printCount: 0,
  createdAt: "2026-11-12T00:00:00.000Z",
};

describe("打印模板白名单", () => {
  it("未知变量直接拒绝，并指出变量名", () => {
    expect(() => analyzeTemplate("<p>{{customer.secret}}</p>", "DELIVERY_NOTE")).toThrowError(
      /未注册的变量/,
    );
  });

  it("循环块内只能用行字段，不能夹带业务表字段", () => {
    expect(() =>
      analyzeTemplate("{{#lines}}{{cost.price}}{{/lines}}", "DELIVERY_NOTE"),
    ).toThrowError(PrintError);
  });

  it("表达式与函数调用不是合法变量路径", () => {
    expect(() => analyzeTemplate("{{1 + 2}}", "PICKING_LIST")).toThrowError(/只能写字段路径/);
  });

  it("引用字段为空时拒绝打印（不允许打印空值），预览可放行", () => {
    const body = "{{shipment.address}}";
    const values = {
      scalars: { "shipment.address": null },
      loops: {},
    };
    expect(() => renderTemplate(body, "DELIVERY_NOTE", values, { format: "HTML" })).toThrowError(
      /缺少可打印字段/,
    );
    expect(
      renderTemplate(body, "DELIVERY_NOTE", values, { format: "HTML", allowMissing: true }),
    ).toBe("");
  });

  it("HTML 输出转义用户数据，ZPL 不转义", () => {
    const values = {
      scalars: { "customer.name": "<script>x</script>", "order.no": "WO-1" },
      loops: {},
    };
    expect(renderTemplate("{{customer.name}}", "PICKING_LIST", values, { format: "HTML" })).toBe(
      "&lt;script&gt;x&lt;/script&gt;",
    );
    expect(renderTemplate("{{customer.name}}", "BOX_LABEL", values, { format: "ZPL" })).toBe(
      "<script>x</script>",
    );
  });
});

describe("一箱一码", () => {
  it("二维码内容 tenant/order/box/seq 可往返，且不含价格", () => {
    const qr = buildBoxQr({ tenantId: TENANT_ID, orderId: ORDER_ID, boxNo: "BOX-12", seq: 3 });
    expect(qr).toBe(`${TENANT_ID}/${ORDER_ID}/BOX-12/3`);
    expect(qr).not.toMatch(/\d+\.\d{2}/);
    expect(parseBoxQr(qr)).toEqual({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      boxNo: "BOX-12",
      seq: 3,
    });
  });

  it("多段、非 UUID、非法箱号一律解析失败", () => {
    expect(parseBoxQr("a/b/BOX-1/1")).toBeNull();
    expect(parseBoxQr(`${TENANT_ID}/${ORDER_ID}/BOX/1/extra`)).toBeNull();
    expect(parseBoxQr(`${TENANT_ID}/${ORDER_ID}/BOX 1/1`)).toBeNull();
    expect(parseBoxQr(`${TENANT_ID}/${ORDER_ID}/BOX/0`)).toBeNull();
  });
});

describe("标签渲染", () => {
  it("ZPL 包含二维码指令与箱号，数量来自视图", () => {
    const zpl = renderBoxLabel({
      view,
      box,
      body: `^XA^BQN,2,8^FDMA,{{box.qr}}^FS^FD{{box.no}} {{box.qty}}^FS^XZ`,
      format: "ZPL",
      reprintReason: null,
    });
    expect(zpl).toContain(`MA,${box.qr}`);
    expect(zpl).toContain("BOX-01 50");
  });

  it("TSPL 使用 QRCODE 指令，补打原因进入标签", () => {
    const tspl = renderBoxLabel({
      view,
      box,
      body: `QRCODE 20,230,L,6,A,0,"{{box.qr}}"\nTEXT 20,640,"TSS16.BF2",0,1,1,"{{meta.reprintReason}}"`,
      format: "TSPL",
      reprintReason: "DAMAGED",
    });
    expect(tspl).toContain(`"${box.qr}"`);
    expect(tspl).toContain("DAMAGED");
  });
});

describe("二维码载荷旁路", () => {
  const values = (qr: string) => ({ scalars: { "card.qr": qr }, loops: {} });

  it("合法 URL / token 原样进指令，逗号与百分号不被清洗", () => {
    const payload = "https://app.weave.test/c/AbC-12_3?x=1,2%20y#frag";
    for (const format of ["ZPL", "TSPL"] as const) {
      expect(renderTemplate("{{card.qr}}", "SAMPLE_LABEL", values(payload), { format })).toBe(
        payload,
      );
    }
  });

  it("出现 ZPL 指令字符时报错，而不是静默换成空格", () => {
    expect(() =>
      renderTemplate("{{card.qr}}", "SAMPLE_LABEL", values("https://x.test/c/a~b"), {
        format: "ZPL",
      }),
    ).toThrowError(/二维码载荷含非法字符/);
    expect(() =>
      renderTemplate("{{card.qr}}", "SAMPLE_LABEL", values("https://x.test/c/a^b"), {
        format: "ZPL",
      }),
    ).toThrowError(/二维码载荷含非法字符/);
  });

  it("空白、中文、引号都拒绝，错误码固定", () => {
    for (const payload of ["a b", "样品/1", 'a"b', "a\\b", "a\r\nb"]) {
      try {
        renderTemplate(
          "{{box.qr}}",
          "TEST_LABEL",
          { scalars: { "box.qr": payload }, loops: {} },
          {
            format: "TSPL",
          },
        );
        throw new Error(`应当拒绝：${JSON.stringify(payload)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(PrintError);
        expect((error as PrintError).code).toBe("PRINT_QR_PAYLOAD_INVALID");
      }
    }
  });
});

describe("A4 PDF", () => {
  it("内置版式输出可解析的 PDF（含中文）", async () => {
    const pdf = await renderBuiltinA4Pdf({ ...view, kind: "DELIVERY_NOTE", title: "发货单" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
