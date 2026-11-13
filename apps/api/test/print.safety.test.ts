import { describe, expect, it } from "vitest";
import {
  assertHtmlTemplateSafe,
  sanitizeHtmlForPrint,
  templateSafetyViolation,
} from "../src/print/html-safety";
import { chromePrintArgs } from "../src/print/pdf";
import { assertTemplatePublishAllowed } from "../src/print/print-templates.service";
import { PrintError, renderTemplate } from "../src/print/template-engine";
import { SYSTEM_TEMPLATES } from "../src/print/templates";
import type { KernelContext } from "../src/kernel";

const OWNER: KernelContext = { actor: { type: "HUMAN", id: "owner", role: "OWNER" } };
const SALES_MEMBER: KernelContext = { actor: { type: "HUMAN", id: "member", role: "SALES" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "print-agent" } };

describe("打印模板发布安全闸", () => {
  it("拒绝 <script> 及其它可执行标签", () => {
    expect(() => assertHtmlTemplateSafe("<h1>hi</h1><script>alert(1)</script>")).toThrowError(
      PrintError,
    );
    expect(() => assertHtmlTemplateSafe("<iframe src=x></iframe>")).toThrowError(/不安全/);
    expect(() => assertHtmlTemplateSafe("<object data=x></object>")).toThrowError(/不安全/);
    expect(() => assertHtmlTemplateSafe('<div onclick="steal()">x</div>')).toThrowError(/不安全/);
    expect(() => assertHtmlTemplateSafe('<a href="javascript:alert(1)">x</a>')).toThrowError(
      /不安全/,
    );
    expect(() =>
      assertHtmlTemplateSafe('<meta http-equiv="refresh" content="0;url=http://x">'),
    ).toThrowError(/不安全/);
  });

  it("拒绝远程 src / CSS url() / @import（防内网与云元数据探测）", () => {
    expect(() =>
      assertHtmlTemplateSafe('<img src="http://169.254.169.254/latest/meta-data/">'),
    ).toThrowError(/远程/);
    expect(() => assertHtmlTemplateSafe('<img src="//evil.example/x.png">')).toThrowError(/远程/);
    expect(() =>
      assertHtmlTemplateSafe('<div style="background-image:url(https://evil.example/x.png)">'),
    ).toThrowError(/url\(\)/);
    expect(() => assertHtmlTemplateSafe("<style>@import 'http://evil.example/a.css';</style>")).toThrowError(
      /@import/,
    );
    expect(() => assertHtmlTemplateSafe('<div style="width:expression(alert(1))">')).toThrowError(
      /expression/,
    );
  });

  it("放行内置 HTML 模板与常规版式（内联样式、data:image、锚点）", () => {
    for (const template of SYSTEM_TEMPLATES) {
      if (template.format !== "HTML") continue;
      expect(templateSafetyViolation(template.body)).toBeNull();
    }
    expect(() =>
      assertHtmlTemplateSafe(
        '<style>@page { size: A4 } td { border: 1px solid #eee }</style>' +
          '<div class="box" style="text-align:right"><a href="#top">回到顶部</a></div>' +
          '<img src="data:image/png;base64,iVBORw0KGgo=">',
      ),
    ).not.toThrow();
  });

  it("HTML 模板只允许 OWNER 发布，ZPL/TSPL 不受影响", () => {
    expect(() => assertTemplatePublishAllowed("HTML", OWNER)).not.toThrow();
    expect(() => assertTemplatePublishAllowed("ZPL", SALES_MEMBER)).not.toThrow();
    expect(() => assertTemplatePublishAllowed("TSPL", AGENT)).not.toThrow();

    expect(() => assertTemplatePublishAllowed("HTML", SALES_MEMBER)).toThrowError(/OWNER/);
    expect(() => assertTemplatePublishAllowed("HTML", AGENT)).toThrowError(/OWNER/);
  });
});

describe("渲染前清洗（存量模板兜底）", () => {
  it("去掉脚本、远程资源与事件属性，保留版式", () => {
    const sanitized = sanitizeHtmlForPrint(
      '<style>td{border:1px solid #eee}</style>' +
        "<script>fetch('http://169.254.169.254/latest/meta-data/')</script>" +
        '<img src="https://evil.example/pixel.png">' +
        '<div onclick="alert(1)" style="background:url(http://evil.example/bg.png)">x</div>',
    );

    expect(sanitized).not.toMatch(/<script/i);
    expect(sanitized).not.toMatch(/onclick/i);
    // 离线断言：清洗后的文档里不存在任何可外联的绝对地址。
    expect(sanitized).not.toMatch(/https?:\/\//i);
    expect(sanitized).not.toMatch(/url\(\s*["']?(?:https?:|\/\/)/i);
    // 版式不被误伤。
    expect(sanitized).toContain("border:1px solid #eee");
  });

  it("渲染结果里没有可外联引用（假 fetch / 离线断言）", () => {
    const values = {
      scalars: {
        "customer.name": "青禾服饰",
        "meta.missing": "",
        "meta.printedAt": "2026-11-13 10:00",
        "meta.operator": "owner",
        "meta.reprintReason": "—",
        "order.no": "WO-1",
        "order.date": "2026-11-13",
        "order.dueDate": "—",
        "order.currency": "CNY",
        "shipment.no": "SH-1",
        "shipment.date": "2026-11-13",
        "shipment.carrier": "顺丰",
        "shipment.trackingNumber": "SF1",
        "shipment.address": "杭州",
        "shipment.boxCount": 1,
        "shipment.qty": 1,
        "tenant.name": "织序",
        "tenant.brand": "织序",
        "tenant.address": "杭州",
        "tenant.phone": "1",
        "tenant.email": "a@b.c",
        "totals.amount": null,
        "totals.quantity": 1,
        "totals.currency": "CNY",
      },
      loops: { lines: [], boxes: [] },
    };
    const html = renderTemplate(
      '<p>{{customer.name}}</p><img src="https://evil.example/x.png">',
      "PICKING_LIST",
      values,
      { format: "HTML" },
    );
    const requests: string[] = [];
    const fakeFetch = (url: string) => {
      requests.push(url);
      return Promise.resolve(null);
    };
    // 单元测试不拉起 Chromium：用清洗结果 + 渲染参数做离线断言。
    const page = sanitizeHtmlForPrint(html);
    expect(page).toContain("青禾服饰");
    if (/https?:\/\//i.test(page)) void fakeFetch("https://evil.example/x.png");
    expect(requests).toEqual([]);
  });

  it("Chromium 渲染参数关闭 JS 并阻断所有域名解析", () => {
    const args = chromePrintArgs("/tmp/document.html", "/tmp/document.pdf");
    expect(args).toContain("--disable-javascript");
    expect(args).toContain("--blink-settings=scriptEnabled=false");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    expect(args).toContain("--disable-remote-fonts");
    expect(args.some((arg) => arg.startsWith("--print-to-pdf="))).toBe(true);
  });
});
