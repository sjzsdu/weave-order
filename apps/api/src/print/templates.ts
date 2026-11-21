import { PrintDocumentKindLabel } from "@weave-order/schema";
import type { PrintDocumentKind, PrintTemplateFormat } from "@weave-order/schema";

export interface BuiltinTemplate {
  /** 稳定键，用于 UI 展示与快照追溯。 */
  key: string;
  kind: PrintDocumentKind;
  format: PrintTemplateFormat;
  name: string;
  variant: string | null;
  pageSize: string | null;
  body: string;
}

const A4_STYLE = `
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1a1a1a; font-size: 11px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f2937; padding-bottom: 8px; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: 1px; }
  .sub { color: #6b7280; font-size: 10px; margin-top: 2px; }
  h1 { font-size: 22px; margin: 14px 0 6px; }
  .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 16px; margin: 10px 0 14px; }
  .meta div { border-bottom: 1px dotted #d1d5db; padding: 3px 0; }
  .meta b { color: #6b7280; font-weight: 500; margin-right: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { background: #f3f4f6; text-align: left; padding: 6px; border: 1px solid #d1d5db; font-size: 10px; }
  td { padding: 6px; border: 1px solid #e5e7eb; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-top: 10px; display: flex; justify-content: flex-end; gap: 24px; font-size: 12px; }
  .boxes { margin-top: 12px; font-size: 10px; color: #374151; }
  .footer { margin-top: 26px; border-top: 1px solid #e5e7eb; padding-top: 6px; color: #9ca3af; font-size: 9px; display: flex; justify-content: space-between; }
  .missing { background: #fef3c7; }
`;

function header(title: string): string {
  return `<div class="head">
    <div>
      <div class="brand">{{tenant.name}}</div>
      <div class="sub">{{tenant.brand}}</div>
    </div>
    <div class="sub" style="text-align:right">
      <div>打印时间 {{meta.printedAt}}</div>
      <div>操作人 {{meta.operator}}</div>
    </div>
  </div>
  <h1>${title}</h1>`;
}

const PICKING_LIST_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>拣货单</title><style>${A4_STYLE}</style></head>
<body>
  ${header("拣货单")}
  <div class="meta">
    <div><b>订单号</b>{{order.no}}</div>
    <div><b>客户</b>{{customer.name}}</div>
    <div><b>发货单</b>{{shipment.no}}</div>
    <div><b>订单日期</b>{{order.date}}</div>
    <div><b>交期</b>{{order.dueDate}}</div>
    <div><b>箱数</b>{{shipment.boxCount}}</div>
  </div>
  <table>
    <thead><tr><th style="width:32px">#</th><th>品名</th><th>样品编号</th><th>货位</th><th>批次</th><th class="num">数量</th><th>单位</th><th style="width:44px">勾选</th></tr></thead>
    <tbody>
      {{#lines}}<tr><td></td><td>{{line.description}}</td><td>{{line.sampleCode}}</td><td>{{line.location}}</td><td>{{line.lot}}</td><td class="num">{{line.quantity}}</td><td>{{line.unit}}</td><td>☐</td></tr>{{/lines}}
      {{^lines}}<tr><td colspan="8">没有可拣货明细</td></tr>{{/lines}}
    </tbody>
  </table>
  <div class="totals"><span>合计数量</span><strong>{{totals.quantity}}</strong><span>箱数</span><strong>{{shipment.boxCount}}</strong></div>
  <div class="footer"><span>拣货后请逐行勾选，再扫码装箱复核。</span><span>缺失：{{meta.missing}}</span></div>
</body></html>`;

const DELIVERY_NOTE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>发货单</title><style>${A4_STYLE}</style></head>
<body>
  ${header("发货单 / DELIVERY NOTE")}
  <div class="meta">
    <div><b>发货单号</b>{{shipment.no}}</div>
    <div><b>订单号</b>{{order.no}}</div>
    <div><b>发货日期</b>{{shipment.date}}</div>
    <div><b>客户</b>{{customer.name}}</div>
    <div><b>联系人</b>{{customer.contactName}}</div>
    <div><b>电话</b>{{customer.phone}}</div>
    <div><b>收货地址</b>{{shipment.address}}</div>
    <div><b>承运商</b>{{shipment.carrier}}</div>
    <div><b>运单号</b>{{shipment.trackingNumber}}</div>
  </div>
  <table>
    <thead><tr><th style="width:32px">#</th><th>品名</th><th>样品编号</th><th class="num">数量</th><th>单位</th><th class="num">单价</th><th class="num">金额</th></tr></thead>
    <tbody>
      {{#lines}}<tr><td></td><td>{{line.description}}</td><td>{{line.sampleCode}}</td><td class="num">{{line.quantity}}</td><td>{{line.unit}}</td><td class="num">{{line.unitPrice}}</td><td class="num">{{line.lineTotal}}</td></tr>{{/lines}}
      {{^lines}}<tr><td colspan="7">没有发货明细</td></tr>{{/lines}}
    </tbody>
  </table>
  <div class="totals"><span>合计数量</span><strong>{{totals.quantity}}</strong><span>合计金额（分）</span><strong>{{totals.amount}}</strong><span>{{totals.currency}}</span></div>
  <div class="boxes">箱号：{{#boxes}}{{box.no}}（{{box.qty}}） {{/boxes}}</div>
  <div class="footer"><span>{{tenant.name}} · {{tenant.address}} · {{tenant.phone}}</span><span>{{tenant.email}}</span></div>
</body></html>`;

const PACKING_LIST_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>装箱单</title><style>${A4_STYLE}</style></head>
<body>
  ${header("装箱单 / PACKING LIST")}
  <div class="meta">
    <div><b>发货单</b>{{shipment.no}}</div>
    <div><b>订单号</b>{{order.no}}</div>
    <div><b>客户</b>{{customer.name}}</div>
    <div><b>收货地址</b>{{customer.address}}</div>
    <div><b>箱数</b>{{shipment.boxCount}}</div>
    <div><b>总数量</b>{{totals.quantity}}</div>
  </div>
  <table>
    <thead><tr><th>箱号</th><th>标签序号</th><th>本箱数量</th><th>毛重</th><th>二维码</th></tr></thead>
    <tbody>{{#boxes}}<tr><td>{{box.no}}</td><td>{{box.seq}}</td><td>{{box.qty}}</td><td>{{box.grossWeight}}</td><td style="font-family:monospace">{{box.qr}}</td></tr>{{/boxes}}</tbody>
  </table>
  <div class="footer"><span>装箱差异必须当场核对，不允许带差异发货。</span><span>{{meta.printedAt}}</span></div>
</body></html>`;

const BOX_LABEL_ZPL = `^XA
^PW812
^LL812
^CI28
^FO40,36^A0N,44,44^FD{{tenant.name}}^FS
^FO40,96^GB732,2,2^FS
^FO40,124^A0N,32,32^FD{{customer.name}}^FS
^FO40,172^A0N,34,34^FD{{order.no}}  {{box.no}}^FS
^FO40,220^A0N,26,26^FDPKG {{box.seq}} / {{shipment.boxCount}}   QTY {{box.qty}}^FS
^FO40,262^BQN,2,8^FDMA,{{box.qr}}^FS
^FO40,700^A0N,22,22^FD{{meta.printedAt}}  {{meta.operator}}^FS
^FO40,736^A0N,20,20^FD{{shipment.address}}^FS
^XZ`;

const BOX_LABEL_TSPL = `SIZE 100 mm,100 mm
GAP 2 mm,0 mm
DIRECTION 1
CLS
TEXT 20,20,"TSS24.BF2",0,1,1,"{{tenant.name}}"
BAR 20,70,760,3
TEXT 20,90,"TSS24.BF2",0,1,1,"{{customer.name}}"
TEXT 20,130,"TSS24.BF2",0,1,1,"{{order.no}} {{box.no}}"
TEXT 20,170,"TSS16.BF2",0,1,1,"PKG {{box.seq}}/{{shipment.boxCount}}  QTY {{box.qty}}"
QRCODE 20,230,L,6,A,0,"{{box.qr}}"
TEXT 20,640,"TSS16.BF2",0,1,1,"{{meta.printedAt}}"
TEXT 20,670,"TSS16.BF2",0,1,1,"{{shipment.address}}"
PRINT 1,1
`;

const TEST_LABEL_ZPL = `^XA
^PW812
^LL406
^CI28
^FO40,40^A0N,42,42^FD{{tenant.name}} 测试标签^FS
^FO40,110^A0N,28,28^FD{{box.no}} / seq {{box.seq}}^FS
^FO40,160^BQN,2,7^FDMA,{{box.qr}}^FS
^FO40,340^A0N,22,22^FD{{meta.printedAt}} {{meta.operator}}^FS
^XZ`;

const TEST_LABEL_TSPL = `SIZE 100 mm,60 mm
GAP 2 mm,0 mm
DIRECTION 1
CLS
TEXT 20,20,"TSS24.BF2",0,1,1,"{{tenant.name}} 测试标签"
TEXT 20,70,"TSS16.BF2",0,1,1,"{{box.no}} / {{box.seq}}"
QRCODE 20,120,L,5,A,0,"{{box.qr}}"
TEXT 20,400,"TSS16.BF2",0,1,1,"{{meta.printedAt}} {{meta.operator}}"
PRINT 1,1
`;

const SAMPLE_CARD_A4_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>样卡</title><style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; color: #14161a; margin: 0; }
  .card { width: 100%; border: 1.2px solid #c9ced6; border-radius: 4px; padding: 10mm 10mm 8mm; display: flex; flex-direction: column; gap: 4mm; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { font-size: 15px; font-weight: 600; letter-spacing: .5px; }
  .kind { font-size: 9px; color: #6b7280; letter-spacing: 2px; }
  .code { font-size: 34px; font-weight: 700; line-height: 1.1; margin-top: 2mm; }
  .name { font-size: 15px; margin-top: 1mm; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  td { padding: 2.2mm 0; border-bottom: 1px dotted #d7dbe1; vertical-align: top; }
  td.k { width: 22mm; color: #6b7280; }
  .bottom { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; margin-top: 3mm; }
  .contact .label { font-size: 9px; color: #6b7280; letter-spacing: 1px; }
  .contact .who { font-size: 16px; font-weight: 600; margin-top: 1.5mm; }
  .contact .tel { font-size: 12px; color: #4b5563; margin-top: 1mm; font-variant-numeric: tabular-nums; }
  .contact .hint { font-size: 8px; color: #9ca3af; margin-top: 2mm; }
  .qr { text-align: center; }
  .qr img { width: 32mm; height: 32mm; display: block; }
  .qr span { font-size: 8px; color: #9ca3af; }
  .foot { display: flex; justify-content: space-between; font-size: 8px; color: #9ca3af; border-top: 1px solid #eef0f3; padding-top: 2mm; }
</style></head>
<body>
  <div class="card">
    <div class="top">
      <div>
        <div class="brand">{{tenant.brand}}</div>
        <div class="kind">样卡 / SAMPLE CARD</div>
      </div>
      <div class="kind">报价 {{quote.no}}</div>
    </div>
    <div>
      <div class="code">{{sample.code}}</div>
      <div class="name">{{sample.name}}</div>
    </div>
    <table>
      <tr><td class="k">成分</td><td>{{sample.composition}}</td></tr>
      <tr><td class="k">克重</td><td>{{sample.weight}}</td></tr>
      <tr><td class="k">品类</td><td>{{sample.category}}</td></tr>
    </table>
    <div class="bottom">
      <div class="contact">
        <div class="label">联系业务员</div>
        <div class="who">{{salesperson.name}}</div>
        <div class="tel">{{salesperson.phone}}</div>
        <div class="hint">扫码只看样品编号与联系方式</div>
      </div>
      <div class="qr">
        <img src="{{card.qrImage}}" alt="样卡二维码">
        <span>扫码联系业务员</span>
      </div>
    </div>
    <div class="foot">
      <span>打印时间 {{meta.printedAt}} ｜ 操作人 {{meta.operator}}</span>
      <span>补打原因 {{meta.reprintReason}}</span>
    </div>
  </div>
</body></html>`;

/**
 * 80×50mm 热敏标签（203dpi = 640×400 点）。
 * 一行一段、不依赖打印机中文字库以外的资源；二维码由打印机指令生成。
 */
const SAMPLE_CARD_LABEL_ZPL = `^XA
^PW640
^LL400
^CI28
^FO24,12^A0N,26,26^FD{{tenant.brand}}^FS
^FO24,44^GB592,2,2^FS
^FO24,52^A0N,30,30^FD{{sample.code}}^FS
^FO24,88^A0N,20,20^FD{{sample.name}}^FS
^FO24,112^A0N,16,16^FD{{sample.composition}}^FS
^FO24,132^A0N,16,16^FD{{sample.weight}}^FS
^FO24,150^BQN,2,5^FDMA,{{card.qr}}^FS
^FO320,176^A0N,20,20^FD{{salesperson.name}}^FS
^FO320,206^A0N,20,20^FD{{salesperson.phone}}^FS
^FO320,240^A0N,16,16^FD{{meta.printedAt}}^FS
^XZ`;

const SAMPLE_CARD_LABEL_TSPL = `SIZE 80 mm,50 mm
GAP 2 mm,0 mm
DIRECTION 1
CLS
TEXT 20,8,"TSS16.BF2",0,1,1,"{{tenant.brand}}"
BAR 20,36,580,2
TEXT 20,44,"TSS24.BF2",0,1,1,"{{sample.code}}"
TEXT 20,78,"TSS16.BF2",0,1,1,"{{sample.name}}"
TEXT 20,102,"TSS16.BF2",0,1,1,"{{sample.composition}}"
TEXT 20,126,"TSS16.BF2",0,1,1,"{{sample.weight}}"
QRCODE 20,150,L,5,A,0,"{{card.qr}}"
TEXT 320,168,"TSS16.BF2",0,1,1,"{{salesperson.name}}"
TEXT 320,196,"TSS16.BF2",0,1,1,"{{salesperson.phone}}"
TEXT 320,230,"TSS16.BF2",0,1,1,"{{meta.printedAt}}"
PRINT 1,1
`;

const BOX_LABEL_LABEL = PrintDocumentKindLabel.BOX_LABEL;

export const SYSTEM_TEMPLATES: BuiltinTemplate[] = [
  {
    key: "system/picking-list/classic",
    kind: "PICKING_LIST",
    format: "HTML",
    name: "系统 · 拣货单（经典）",
    variant: null,
    pageSize: "A4",
    body: PICKING_LIST_HTML,
  },
  {
    key: "system/delivery-note/classic",
    kind: "DELIVERY_NOTE",
    format: "HTML",
    name: "系统 · 发货单（经典）",
    variant: null,
    pageSize: "A4",
    body: DELIVERY_NOTE_HTML,
  },
  {
    key: "system/packing-list/classic",
    kind: "PACKING_LIST",
    format: "HTML",
    name: "系统 · 装箱单（经典）",
    variant: null,
    pageSize: "A4",
    body: PACKING_LIST_HTML,
  },
  {
    key: "system/box-label/zpl",
    kind: "BOX_LABEL",
    format: "ZPL",
    name: `系统 · ${BOX_LABEL_LABEL}（ZPL 100×100）`,
    variant: null,
    pageSize: "100x100",
    body: BOX_LABEL_ZPL,
  },
  {
    key: "system/box-label/tspl",
    kind: "BOX_LABEL",
    format: "TSPL",
    name: `系统 · ${BOX_LABEL_LABEL}（TSPL 100×100）`,
    variant: null,
    pageSize: "100x100",
    body: BOX_LABEL_TSPL,
  },
  {
    key: "system/sample-card/classic-a4",
    kind: "SAMPLE_LABEL",
    format: "HTML",
    name: "系统 · 样卡（A4）",
    variant: null,
    pageSize: "A4",
    body: SAMPLE_CARD_A4_HTML,
  },
  {
    key: "system/sample-card/zpl-80x50",
    kind: "SAMPLE_LABEL",
    format: "ZPL",
    name: "系统 · 样卡标签（ZPL 80×50）",
    variant: null,
    pageSize: "80x50",
    body: SAMPLE_CARD_LABEL_ZPL,
  },
  {
    key: "system/sample-card/tspl-80x50",
    kind: "SAMPLE_LABEL",
    format: "TSPL",
    name: "系统 · 样卡标签（TSPL 80×50）",
    variant: null,
    pageSize: "80x50",
    body: SAMPLE_CARD_LABEL_TSPL,
  },
  {
    key: "system/test-label/zpl",
    kind: "TEST_LABEL",
    format: "ZPL",
    name: "系统 · 测试标签（ZPL）",
    variant: null,
    pageSize: "100x60",
    body: TEST_LABEL_ZPL,
  },
  {
    key: "system/test-label/tspl",
    kind: "TEST_LABEL",
    format: "TSPL",
    name: "系统 · 测试标签（TSPL）",
    variant: null,
    pageSize: "100x60",
    body: TEST_LABEL_TSPL,
  },
];

export function builtinTemplatesFor(kind: PrintDocumentKind): BuiltinTemplate[] {
  return SYSTEM_TEMPLATES.filter((template) => template.kind === kind);
}

export function builtinTemplate(kind: PrintDocumentKind, format: PrintTemplateFormat) {
  return SYSTEM_TEMPLATES.find((template) => template.kind === kind && template.format === format);
}
