import { createDb } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildQuoteDocumentSnapshot, createQuoteExportService } from "../src/export";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

/**
 * 报价出口集成测试：真实 PostgreSQL（docker compose up -d && pnpm db:migrate）。
 * 没有数据库时整组跳过——发送记录的写入/读回放在这里验证，单元测试不依赖 DB。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "integration-sales" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "integration-agent" } };

let probe: Pool | null = null;
let db: Db | null = null;
let available = false;

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.quote_sends') IS NOT NULL AS exists",
    );
    available = table.rows[0]?.exists === true;
    if (available) db = createDb(DATABASE_URL).db;
  } catch {
    available = false;
  } finally {
    await probe.end();
    probe = null;
  }
});

afterAll(async () => {
  await probe?.end();
});

function kernelOf(): Kernel {
  if (!db) throw new Error("数据库不可用");
  return createKernel(db);
}

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 建一份「客户 + 样品 + 报价草稿」，可选是否已确认。 */
async function seedQuote(
  kernel: Kernel,
  options: { confirm: boolean },
): Promise<{ quoteId: string; customerId: string }> {
  const id = suffix();
  const customer = await kernel.customers.create(
    { code: `IT-EXP-C-${id}`, name: "出口测试客户" },
    HUMAN,
  );
  const sample = await kernel.samples.create(
    { code: `IT-EXP-S-${id}`, name: "出口测试面料", unit: "meter" },
    HUMAN,
  );
  const draft = await kernel.quotes.generateDraft(
    {
      customerId: customer.id,
      currency: "CNY",
      validityDays: 15,
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: 500, unit: "meter" },
          unitPrice: { amount: 2350, currency: "CNY" },
        },
      ],
    },
    AGENT,
  );
  if (options.confirm) await kernel.quotes.confirmDraft(draft.id, HUMAN);
  return { quoteId: draft.id, customerId: customer.id };
}

describe("报价出口（集成）", () => {
  it("确认后明细仍可读：getDetail 不限制状态，getDraft 的 DRAFT 约束不变", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const { quoteId } = await seedQuote(kernel, { confirm: true });

    const detail = await kernel.quotes.getDetail(quoteId);
    expect(detail.status).toBe("SENT");
    expect(detail.items).toHaveLength(1);
    expect(detail.total.amount).toBe(1175000);
    expect(detail.validityDays).toBe(15);

    await expect(kernel.quotes.getDraft(quoteId)).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "INVALID_STATE_TRANSITION" },
    });
  }, 20_000);

  it("发送记录：导出动作落库（谁 / 何时 / 渠道 / 接收方 / 版本快照）+ 审计", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const { quoteId } = await seedQuote(kernel, { confirm: true });
    const detail = await kernel.quotes.getDetail(quoteId);
    const snapshot = buildQuoteDocumentSnapshot({
      detail,
      company: { name: "织序纺织有限公司", address: null, phone: null, email: null },
      terms: ["报价以本单为准。"],
      generatedAt: new Date("2026-11-12T06:12:00.000Z"),
    });

    const send = await kernel.quotes.recordSend(quoteId, HUMAN, {
      recipient: "王经理 微信",
      snapshot,
    });

    expect(send.quoteId).toBe(quoteId);
    expect(send.channel).toBe("MANUAL_EXPORT");
    expect(send.format).toBe("PDF");
    expect(send.actorType).toBe("HUMAN");
    expect(send.actorId).toBe(HUMAN.actor.id);
    expect(send.recipient).toBe("王经理 微信");
    expect(send.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(send.snapshot.customer.name).toBe("出口测试客户");
    // 阶段一没有渠道回执，且绝不能伪造回执字段。
    expect(send.receiptStatus).toBeNull();
    expect(send.receiptAt).toBeNull();
    expect(send.externalRef).toBeNull();

    const sends = await kernel.quotes.listSends(quoteId);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.id).toBe(send.id);

    const audit = await kernel.audit.list(50);
    const record = audit.find((row) => row.action === "QUOTE_EXPORTED" && row.entityId === quoteId);
    expect(record).toBeDefined();
    expect(record?.actorType).toBe("HUMAN");
    expect(record?.after).toMatchObject({ sendId: send.id, channel: "MANUAL_EXPORT" });
  }, 20_000);

  it("未确认的报价不能记发送；智能体也不能代替人记", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const { quoteId } = await seedQuote(kernel, { confirm: false });
    const detail = await kernel.quotes.getDetail(quoteId);
    const snapshot = buildQuoteDocumentSnapshot({
      detail,
      company: { name: "织序纺织有限公司", address: null, phone: null, email: null },
      terms: [],
      generatedAt: new Date("2026-11-12T06:12:00.000Z"),
    });

    await expect(
      kernel.quotes.recordSend(quoteId, HUMAN, { snapshot }),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "QUOTE_NOT_CONFIRMED" },
    });
    expect(await kernel.quotes.listSends(quoteId)).toHaveLength(0);

    await kernel.quotes.confirmDraft(quoteId, HUMAN);
    await expect(kernel.quotes.recordSend(quoteId, AGENT, { snapshot })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(await kernel.quotes.listSends(quoteId)).toHaveLength(0);
  }, 20_000);

  it("导出服务端到端：返回可下载 PDF 并留下一条发送记录", async (ctx) => {
    if (!available) ctx.skip();
    const kernel = kernelOf();
    const { quoteId } = await seedQuote(kernel, { confirm: true });
    const service = createQuoteExportService(kernel, {
      company: { name: "织序纺织有限公司", address: null, phone: null, email: null },
      terms: ["报价以本单为准。"],
    });

    const result = await service.exportQuote(quoteId, HUMAN, { recipient: "王经理" });
    expect(result.filename).toMatch(/^quotation-.*\.pdf$/);
    expect(Buffer.from(result.bytes).toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(result.send.channel).toBe("MANUAL_EXPORT");

    const sends = await service.listSends(quoteId);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.recipient).toBe("王经理");
  }, 30_000);
});
