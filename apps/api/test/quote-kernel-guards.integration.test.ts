import { auditLog, createDb, quotes } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

type DbHandle = ReturnType<typeof createDb>;

/**
 * 报价内核的不变式回归（WAN-96）：有效期、审批上下文、换样折算、成本底线。
 *
 * 与 `concurrency-regression` 一样不允许静默跳过：没有库就在 `beforeAll` 抛出，
 * 让「用例没跑」当场可见，而不是绿在 main 上。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const AGENT: KernelContext = { actor: { type: "AGENT", id: "wan96-agent" } };
const OWNER: KernelContext = { actor: { type: "HUMAN", id: "wan96-owner", role: "OWNER" } };
const MANAGER: KernelContext = { actor: { type: "HUMAN", id: "wan96-manager", role: "MANAGER" } };

let handle: DbHandle | null = null;
let db: Db | null = null;
let kernel: Kernel | null = null;

beforeAll(async () => {
  const created = createDb(DATABASE_URL);
  try {
    const probe = await created.pool.query<{ quotes: boolean }>(
      `SELECT to_regclass('public.quotes') IS NOT NULL AS quotes`,
    );
    if (probe.rows[0]?.quotes !== true) throw new Error("缺少 quotes 表，迁移尚未执行");
  } catch (error) {
    await created.pool.end();
    throw new Error(
      `[WAN-96] 需要 PostgreSQL（${DATABASE_URL}）：${
        error instanceof Error ? error.message : String(error)
      }。本用例禁止静默跳过。`,
    );
  }
  handle = created;
  db = created.db;
  kernel = createKernel(created.db);
});

afterAll(async () => {
  await handle?.pool.end();
  handle = null;
  db = null;
  kernel = null;
});

function requireKernel(): { db: Db; kernel: Kernel } {
  if (!db || !kernel) throw new Error("[WAN-96] 前置失败：PostgreSQL 不可用");
  return { db, kernel };
}

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface SeededQuote {
  customerId: string;
  quoteId: string;
  sampleId: string;
}

async function seedQuote(
  k: Kernel,
  options: {
    amountCents: number;
    unitPriceCents: number;
    unit?: "meter" | "kilogram";
    costFloorCents?: number;
    validityDays?: number;
    agentId?: string;
  },
): Promise<SeededQuote> {
  const tag = suffix();
  const customer = await k.customers.create({ code: `W96-C-${tag}`, name: "WAN96 客户" }, OWNER);
  const sample = await k.samples.create(
    {
      code: `W96-S-${tag}`,
      name: "WAN96 面料",
      unit: options.unit ?? "meter",
      costFloor: { amount: options.costFloorCents ?? 100, currency: "CNY" as const },
    },
    OWNER,
  );
  const quantity = options.amountCents / options.unitPriceCents;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("seedQuote：amountCents 必须是 unitPriceCents 的整数倍");
  }
  const draft = await k.quotes.generateDraft(
    {
      customerId: customer.id,
      currency: "CNY",
      ...(options.validityDays === undefined ? {} : { validityDays: options.validityDays }),
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: quantity, unit: options.unit ?? "meter" },
          unitPrice: { amount: options.unitPriceCents, currency: "CNY" },
        },
      ],
    },
    options.agentId ? { actor: { type: "AGENT", id: options.agentId } } : AGENT,
  );
  return { customerId: customer.id, quoteId: draft.id, sampleId: sample.id };
}

async function quoteRow(conn: Db, quoteId: string) {
  const rows = await conn.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  return rows[0];
}

async function auditCount(
  conn: Db,
  quoteId: string,
  action: "QUOTE_CONFIRMED" | "QUOTE_REJECTED",
): Promise<number> {
  const rows = await conn
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, quoteId), eq(auditLog.action, action)));
  return rows.length;
}

describe("报价内核不变式（WAN-96）", () => {
  it("过期草稿 confirm 返回 QUOTE_EXPIRED，且不写确认审计", async () => {
    const { db: conn, kernel: k } = requireKernel();
    const { quoteId } = await seedQuote(k, { amountCents: 30_000, unitPriceCents: 300 });

    await conn
      .update(quotes)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(quotes.id, quoteId));

    await expect(k.quotes.confirmDraft(quoteId, OWNER)).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "QUOTE_EXPIRED" },
    });

    const row = await quoteRow(conn, quoteId);
    expect(row?.status).toBe("DRAFT");
    expect(row?.confirmedBy).toBeNull();
    expect(await auditCount(conn, quoteId, "QUOTE_CONFIRMED")).toBe(0);
  }, 30_000);

  it("批准以落库审批角色为准：个人级更严限额重算不出来，业务员也不能自批", async () => {
    const { db: conn, kernel: k } = requireKernel();
    const salespersonId = `wan96-sales-${suffix()}`;

    // 个人级审批上限 100000 分：只对这个人生效，公司级仍是 500 万分。
    await k.pricing.create(
      {
        scopeType: "PERSON",
        scopeId: salespersonId,
        key: "approval.sales.limit",
        value: 100_000,
        locked: true,
      },
      OWNER,
    );

    // 草稿由该业务员发起：生成时带 personId，审批角色应被算到 MANAGER。
    const { quoteId } = await seedQuote(k, {
      amountCents: 300_000,
      unitPriceCents: 3_000,
      agentId: salespersonId,
    });
    const seeded = await quoteRow(conn, quoteId);
    expect(seeded?.requiredApprovalRole).toBe("MANAGER");

    // 批准时只用 customerId 重算会得到 SALES（公司级 500 万），正是要防的放宽。
    await expect(
      k.quotes.confirmDraft(quoteId, {
        actor: { type: "HUMAN", id: salespersonId, role: "SALES" },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    const confirmed = await k.quotes.confirmDraft(quoteId, MANAGER);
    expect(confirmed.status).toBe("SENT");
  }, 30_000);

  it("成员级审批额度：额度 100000 分的业务员不能自批 300000 分的报价", async () => {
    const { kernel: k } = requireKernel();
    const { quoteId } = await seedQuote(k, { amountCents: 300_000, unitPriceCents: 3_000 });

    await expect(
      k.quotes.confirmDraft(quoteId, {
        actor: { type: "HUMAN", id: "wan96-limited-sales", role: "SALES", approvalLimitAmount: 100_000 },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  }, 30_000);

  it("换样且单位不同、未显式折算 → UNIT_MISMATCH；给出折算数量后落库单位随之变化", async () => {
    const { db: conn, kernel: k } = requireKernel();
    const { quoteId, customerId } = await seedQuote(k, {
      amountCents: 20_000,
      unitPriceCents: 2_000,
      unit: "meter",
      costFloorCents: 1_000,
    });
    const kgSample = await k.samples.create(
      {
        code: `W96-KG-${suffix()}`,
        name: "按公斤计价面料",
        unit: "kilogram",
        costFloor: { amount: 1_000, currency: "CNY" },
      },
      OWNER,
    );
    expect(customerId).toBeTruthy();

    await expect(
      k.quotes.reviseDraft(
        {
          quoteId,
          baseVersion: 1,
          source: "INLINE",
          instruction: "换成按公斤计价的样品",
          lines: [{ lineIndex: 0, fabricSampleId: kgSample.id }],
        },
        OWNER,
      ),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "UNIT_MISMATCH" },
    });

    const revised = await k.quotes.reviseDraft(
      {
        quoteId,
        baseVersion: 1,
        source: "INLINE",
        instruction: "换成按公斤计价的样品，数量按 10 公斤折算",
        lines: [
          {
            lineIndex: 0,
            fabricSampleId: kgSample.id,
            quantity: { value: 10, unit: "kilogram" },
          },
        ],
      },
      OWNER,
    );
    expect(revised.draft.items[0]?.quantity.unit).toBe("kilogram");
    expect(revised.draft.items[0]?.quantity.value).toBe(10);
    // 单价没改但数量变了，行金额必须跟着重算。
    expect(revised.draft.total.amount).toBe(20_000);

    const row = await quoteRow(conn, quoteId);
    expect(row?.version).toBe(2);
  }, 30_000);

  it("换样后低于新样品底线、即使没改单价 → PRICE_BELOW_COST_FLOOR", async () => {
    const { kernel: k } = requireKernel();
    const { quoteId } = await seedQuote(k, {
      amountCents: 10_000,
      unitPriceCents: 1_000,
      costFloorCents: 900,
    });
    const pricier = await k.samples.create(
      {
        code: `W96-HI-${suffix()}`,
        name: "高成本面料",
        unit: "meter",
        costFloor: { amount: 1_500, currency: "CNY" },
      },
      OWNER,
    );

    await expect(
      k.quotes.reviseDraft(
        {
          quoteId,
          baseVersion: 1,
          source: "INLINE",
          instruction: "换成成本更高的样品",
          lines: [{ lineIndex: 0, fabricSampleId: pricier.id }],
        },
        OWNER,
      ),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "PRICE_BELOW_COST_FLOOR" },
    });
  }, 30_000);

  it("无成本底线样品：T-004 与 T-006 给出一致结论（COST_FLOOR_MISSING）", async () => {
    const { kernel: k } = requireKernel();
    const tag = suffix();
    const customer = await k.customers.create(
      { code: `W96-NC-${tag}`, name: "无底线客户" },
      OWNER,
    );
    const sample = await k.samples.create(
      { code: `W96-NS-${tag}`, name: "没有成本底线的面料", unit: "meter" },
      OWNER,
    );

    await expect(
      k.quotes.generateDraft(
        {
          customerId: customer.id,
          currency: "CNY",
          items: [
            {
              fabricSampleId: sample.id,
              quantity: { value: 1, unit: "meter" },
              unitPrice: { amount: 5_000, currency: "CNY" },
            },
          ],
        },
        AGENT,
      ),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "COST_FLOOR_MISSING" },
    });

    await expect(
      k.quotePricing.suggestLinePrice({
        customerId: customer.id,
        fabricSampleId: sample.id,
        quantity: { value: 1, unit: "meter" },
        currency: "CNY",
      }),
    ).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "COST_FLOOR_MISSING" },
    });
  }, 30_000);

  it("确认后再驳回：状态机互斥，返回 INVALID_STATE_TRANSITION 且不写驳回审计", async () => {
    const { db: conn, kernel: k } = requireKernel();
    const { quoteId } = await seedQuote(k, { amountCents: 30_000, unitPriceCents: 300 });
    await k.quotes.confirmDraft(quoteId, OWNER);

    await expect(k.quotes.rejectDraft(quoteId, OWNER, "想反悔")).rejects.toMatchObject({
      code: "KERNEL_REJECTED",
      details: { reason: "INVALID_STATE_TRANSITION" },
    });
    expect(await auditCount(conn, quoteId, "QUOTE_REJECTED")).toBe(0);

    const row = await quoteRow(conn, quoteId);
    expect(row?.status).toBe("SENT");
    expect(row?.confirmedBy).toBe(OWNER.actor.id);
  }, 30_000);
});
