import { QuoteDetail, QuoteSendRecord } from "@weave-order/schema";
import { describe, expect, it, vi } from "vitest";
import {
  buildQuoteDocumentSnapshot,
  createQuoteExportService,
  formatCstDate,
  formatQuantity,
  renderQuotePdf,
} from "../src/export";
import type { Kernel, KernelContext } from "../src/kernel";
import { KernelError } from "../src/kernel";
import { hashQuoteSnapshot } from "../src/kernel/quotes.service";

/**
 * 报价出口离线单测：内容快照、版本 hash、PDF 渲染、导出服务。
 * 发送记录落库在 `quote-export.integration.test.ts` 里跑（没有数据库时跳过），
 * 所以 `pnpm test` 在纯离线环境仍然全绿。
 */
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "unit-sales" } };
const QUOTE_ID = "123e4567-e89b-12d3-a456-426614174000";
const CUSTOMER_ID = "123e4567-e89b-12d3-a456-426614174001";

const DETAIL: QuoteDetail = QuoteDetail.parse({
  id: QUOTE_ID,
  customerId: CUSTOMER_ID,
  customer: {
    id: CUSTOMER_ID,
    code: "CUST-0001",
    name: "杭州锦泰纺织品有限公司",
    tier: "VIP",
    contactName: "王经理",
    contactPhone: "138-0000-0000",
    contactEmail: "wang@example.com",
  },
  status: "SENT",
  currency: "CNY",
  items: [
    {
      fabricSampleId: "123e4567-e89b-12d3-a456-426614174010",
      description: "全棉高支府绸 220g/㎡",
      quantity: { value: 500, unit: "meter" },
      unitPrice: { amount: 2350, currency: "CNY" },
      lineTotal: { amount: 1175000, currency: "CNY" },
    },
    {
      fabricSampleId: "123e4567-e89b-12d3-a456-426614174011",
      description: "涤棉混纺斜纹布",
      quantity: { value: 1200.5, unit: "meter" },
      unitPrice: { amount: 1850, currency: "CNY" },
      lineTotal: { amount: 2220925, currency: "CNY" },
    },
  ],
  subtotal: { amount: 3395925, currency: "CNY" },
  total: { amount: 3395925, currency: "CNY" },
  validityDays: 15,
  expiresAt: "2026-11-27T05:37:15.000Z",
  createdAt: "2026-11-12T05:37:15.000Z",
  confirmedBy: "unit-approver",
  confirmedAt: "2026-11-12T06:10:00.000Z",
  remarks: "客户要求 7 天内寄出 A4 色卡。",
});

const GENERATED_AT = new Date("2026-11-12T06:12:00.000Z");
const COMPANY = {
  name: "织序纺织有限公司",
  address: "浙江省绍兴市柯桥区示例路 1 号",
  phone: "0575-0000-0000",
  email: "sales@example.com",
};
const TERMS = ["报价有效期以本单为准。", "大货品质以确认样为准。"];

function snapshotOf(detail: QuoteDetail = DETAIL) {
  return buildQuoteDocumentSnapshot({
    detail,
    company: COMPANY,
    terms: TERMS,
    generatedAt: GENERATED_AT,
  });
}

function sendRecord(overrides: Partial<QuoteSendRecord> = {}): QuoteSendRecord {
  return QuoteSendRecord.parse({
    id: "123e4567-e89b-12d3-a456-426614174099",
    quoteId: QUOTE_ID,
    channel: "MANUAL_EXPORT",
    format: "PDF",
    actorType: "HUMAN",
    actorId: HUMAN.actor.id,
    recipient: "王经理",
    note: null,
    snapshotHash: "a".repeat(64),
    snapshot: snapshotOf(),
    receiptStatus: null,
    receiptAt: null,
    externalRef: null,
    createdAt: GENERATED_AT.toISOString(),
    ...overrides,
  });
}

function makeKernel() {
  const recordSend = vi.fn((_id: string, _ctx: KernelContext, _input: unknown) =>
    Promise.resolve(sendRecord()),
  );
  const listSends = vi.fn((_id: string) => Promise.resolve([sendRecord()]));
  const kernel = {
    quotes: {
      getDetail: vi.fn(() => Promise.resolve(DETAIL)),
      recordSend,
      listSends,
    },
  } as unknown as Kernel;
  return { kernel, recordSend, listSends };
}

describe("报价内容快照", () => {
  it("把账本明细固化成客户可见的内容（客户名 / 明细 / 总额 / 有效期 / 条款）", () => {
    const snapshot = snapshotOf();
    expect(snapshot.customer.name).toBe("杭州锦泰纺织品有限公司");
    expect(snapshot.lines).toHaveLength(2);
    expect(snapshot.lines.map((line) => line.position)).toEqual([0, 1]);
    expect(snapshot.lines[1]?.quantity).toBe(1200.5);
    expect(snapshot.quote.totalCents).toBe(3395925);
    expect(snapshot.quote.validityDays).toBe(15);
    expect(snapshot.terms).toEqual(TERMS);
    expect(snapshot.generatedAt).toBe(GENERATED_AT.toISOString());
  });

  it("同一份内容永远得到同一个版本 hash", () => {
    expect(hashQuoteSnapshot(snapshotOf())).toBe(hashQuoteSnapshot(snapshotOf()));
    expect(hashQuoteSnapshot(snapshotOf())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("内容变了（哪怕只改一行数量）hash 就变——「发的是哪一版」可核对", () => {
    const changed: QuoteDetail = {
      ...DETAIL,
      items: DETAIL.items.map((item, index) =>
        index === 0 ? { ...item, quantity: { value: 501, unit: "meter" } } : item,
      ),
    };
    expect(hashQuoteSnapshot(snapshotOf(changed))).not.toBe(hashQuoteSnapshot(snapshotOf()));
  });
});

describe("报价单 PDF", () => {
  it("渲染出合法 PDF，并内嵌中文字体（不依赖系统字体）", async () => {
    const bytes = await renderQuotePdf(snapshotOf());
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // 内嵌 TrueType 子集：PDF 里有 FontFile2，才可能在没装中文字体的机器上正常显示。
    expect(text).toContain("/FontFile2");
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

  it("明细多于一页时续页（页数 > 1）", async () => {
    const many: QuoteDetail = {
      ...DETAIL,
      items: Array.from({ length: 60 }, (_, index) => {
        const base = DETAIL.items[0];
        if (!base) throw new Error("测试数据缺少明细行");
        return { ...base, description: `${base.description} 第 ${index + 1} 批` };
      }),
    };
    const text = Buffer.from(await renderQuotePdf(snapshotOf(many))).toString("latin1");
    const pages = text.match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });
});

describe("导出服务（离线，假内核）", () => {
  it("导出 = 渲染 PDF + 经内核写一条 MANUAL_EXPORT 发送记录", async () => {
    const { kernel, recordSend } = makeKernel();
    const service = createQuoteExportService(kernel, { company: COMPANY, terms: TERMS });

    const result = await service.exportQuote(QUOTE_ID, HUMAN, { recipient: "王经理" }, GENERATED_AT);

    expect(result.bytes.byteLength).toBeGreaterThan(5_000);
    expect(result.filename).toBe(`quotation-CUST-0001-${QUOTE_ID.slice(0, 8)}.pdf`);
    expect(recordSend).toHaveBeenCalledTimes(1);
    const call = recordSend.mock.calls[0];
    expect(call?.[0]).toBe(QUOTE_ID);
    expect(call?.[1]).toBe(HUMAN);
    expect(call?.[2]).toMatchObject({ recipient: "王经理", note: null });
    const input = call?.[2] as { snapshot: { customer: { name: string }; lines: unknown[] } };
    expect(input.snapshot.customer.name).toBe("杭州锦泰纺织品有限公司");
    expect(input.snapshot.lines).toHaveLength(2);
  });

  it("接收方留空时传 null，不伪造「发给了谁」", async () => {
    const { kernel, recordSend } = makeKernel();
    const service = createQuoteExportService(kernel, { company: COMPANY, terms: TERMS });
    await service.exportQuote(QUOTE_ID, HUMAN, {}, GENERATED_AT);
    const input = recordSend.mock.calls[0]?.[2] as { recipient: unknown };
    expect(input.recipient).toBeNull();
  });

  it("内核拒绝记账时导出整体失败（不会留下「已发送」的假象）", async () => {
    const { kernel, recordSend } = makeKernel();
    recordSend.mockRejectedValueOnce(
      new KernelError("KERNEL_REJECTED", "报价单尚未被确认，不能记录发送", {
        reason: "QUOTE_NOT_CONFIRMED",
      }),
    );
    const service = createQuoteExportService(kernel, { company: COMPANY, terms: TERMS });
    await expect(service.exportQuote(QUOTE_ID, HUMAN, {})).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
    });
  });

  it("发送记录读取直接来自内核", async () => {
    const { kernel, listSends } = makeKernel();
    const service = createQuoteExportService(kernel, { company: COMPANY, terms: TERMS });
    const sends = await service.listSends(QUOTE_ID);
    expect(sends).toHaveLength(1);
    expect(listSends).toHaveBeenCalledWith(QUOTE_ID);
  });
});

describe("展示格式", () => {
  it("数量去掉无意义小数零", () => {
    expect(formatQuantity(500)).toBe("500");
    expect(formatQuantity(1200.5)).toBe("1200.5");
    expect(formatQuantity(2.2501)).toBe("2.25");
  });

  it("日期按东八区展示（有效期是「日子」，不是 UTC 时间点）", () => {
    expect(formatCstDate("2026-11-27T05:37:15.000Z")).toBe("2026-11-27");
    expect(formatCstDate("2026-11-27T20:00:00.000Z")).toBe("2026-11-28");
  });
});
