import { auditLog, createDb, quotes } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";

type DbHandle = ReturnType<typeof createDb>;

/**
 * 并发回归基座：真实 PostgreSQL 上的「并发写账本」不变式。
 *
 * 只写测试，不改业务代码。文件名刻意与 S1-1 自带的
 * `concurrency.integration.test.ts` 区分，避免同批并行抢文件。
 *
 * 与仓库既有集成测试的差别：**不允许 `ctx.skip()`** —— 没有库在 `beforeAll`
 * 直接抛出明确错误，让本地 / CI 一眼看到「用例根本没跑」，而不是假绿。
 * 这里的 `skipIf` 不是「跑不起来就跳过」，而是显式登记「依赖的缺陷还没修」。
 *
 * 轮次是刻意的：竞态即使带概率，多轮也把「溜过 CI」的概率压到接近 0。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

/**
 * 未修复项的挂起开关：`main` 常绿，红用例回到 issue 里去红，而不是绿在 main 上。
 *
 * 每条挂起都在用例上方注明依赖的 issue；**对应修复合入时把开关改回 `false`**，
 * 让用例恢复常驻执行。开关只允许收敛，不允许再往里加新的跳过。
 */
const SUSPENDED_UNTIL_FIXED: Record<"WAN-96", boolean> = {
  /* 报价状态机互斥（confirm 并发 / confirm+reject）—— 归 WAN-96（quotes.service.ts）。 */
  "WAN-96": true,
};

const AGENT: KernelContext = { actor: { type: "AGENT", id: "concurrency-agent" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "concurrency-human", role: "OWNER" } };

/** 应收 1000 分，并发两笔 600 分收款：任何一笔成功都必须落在账本上。 */
const RECEIVABLE_CENTS = 1000;
const PAYMENT_CENTS = 600;
const PAYMENT_ROUNDS = 8;
const CONFIRM_ROUNDS = 5;
const DECISION_ROUNDS = 6;

let handle: DbHandle | null = null;
let db: Db | null = null;
let kernel: Kernel | null = null;

beforeAll(async () => {
  const created = createDb(DATABASE_URL);
  try {
    const probe = await created.pool.query<{ receivables: boolean; quotes: boolean }>(
      `SELECT to_regclass('public.receivables') IS NOT NULL AS receivables,
              to_regclass('public.quotes') IS NOT NULL AS quotes`,
    );
    if (probe.rows[0]?.receivables !== true || probe.rows[0]?.quotes !== true) {
      throw new Error("缺少 receivables / quotes 表，迁移尚未执行");
    }
  } catch (error) {
    await created.pool.end();
    throw new Error(
      `[并发回归] 需要 PostgreSQL（${DATABASE_URL}）才能运行，但探测失败：${
        error instanceof Error ? error.message : String(error)
      }。本用例禁止静默跳过（不允许 ctx.skip()）——请先 docker compose up -d && pnpm db:migrate。`,
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

function requireKernel(): Kernel {
  if (!kernel) {
    throw new Error("[并发回归] 前置失败：PostgreSQL 不可用，本用例不静默跳过");
  }
  return kernel;
}

function requireDb(): { db: Db; kernel: Kernel } {
  if (!db || !kernel) {
    throw new Error("[并发回归] 前置失败：PostgreSQL 不可用，本用例不静默跳过");
  }
  return { db, kernel };
}

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const dueInTwoDays = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

/** 建一单已确认的订单，后续每轮在它下面开一张应收。 */
async function seedConfirmedOrder(k: Kernel, tag: string): Promise<string> {
  const customer = await k.customers.create({ code: `CC-C-${tag}`, name: "并发回归客户" }, HUMAN);
  const sample = await k.samples.create(
    {
      code: `CC-S-${tag}`,
      name: "并发回归面料",
      unit: "meter",
      costFloor: { amount: 1000, currency: "CNY" },
    },
    HUMAN,
  );
  const order = await k.orders.create(
    {
      customerId: customer.id,
      code: `CC-O-${tag}`,
      currency: "CNY",
      items: [
        {
          sampleId: sample.id,
          quantity: { value: 10, unit: "meter" },
          unitPrice: { amount: 2000, currency: "CNY" },
        },
      ],
    },
    HUMAN,
  );
  await k.orders.confirm(order.id, HUMAN);
  return order.id;
}

async function seedDraft(k: Kernel, tag: string, amountCents: number): Promise<string> {
  const customer = await k.customers.create({ code: `CC-QC-${tag}`, name: "并发确认客户" }, HUMAN);
  const sample = await k.samples.create(
    {
      code: `CC-QS-${tag}`,
      name: "并发确认面料",
      unit: "meter",
      costFloor: { amount: 1000, currency: "CNY" },
    },
    HUMAN,
  );
  const draft = await k.quotes.generateDraft(
    {
      customerId: customer.id,
      currency: "CNY",
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: 1, unit: "meter" },
          unitPrice: { amount: amountCents, currency: "CNY" },
        },
      ],
    },
    AGENT,
  );
  return draft.id;
}

async function quoteRow(conn: Db, tenantId: string, quoteId: string) {
  const rows = await conn
    .select()
    .from(quotes)
    .where(and(eq(quotes.id, quoteId), eq(quotes.tenantId, tenantId)))
    .limit(1);
  return rows[0];
}

async function auditCount(
  conn: Db,
  tenantId: string,
  entityId: string,
  action: "QUOTE_CONFIRMED" | "QUOTE_REJECTED",
): Promise<number> {
  const rows = await conn
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantId),
        eq(auditLog.entityId, entityId),
        eq(auditLog.action, action),
      ),
    );
  return rows.length;
}

describe("并发写账本回归（真实 PostgreSQL）", () => {
  it(`并发丢账：应收 ${RECEIVABLE_CENTS} 分并发两笔 ${PAYMENT_CENTS} 分收款，回执与账本必须一致（${PAYMENT_ROUNDS} 轮）`, async () => {
    const k = requireKernel();
    const orderId = await seedConfirmedOrder(k, suffix());

    for (let round = 1; round <= PAYMENT_ROUNDS; round += 1) {
      const receivable = await k.receivables.create(
        { orderId, amount: { amount: RECEIVABLE_CENTS, currency: "CNY" }, dueDate: dueInTwoDays() },
        HUMAN,
      );
      const payment = {
        receivableId: receivable.id,
        amount: { amount: PAYMENT_CENTS, currency: "CNY" as const },
      };
      const attempts = await Promise.allSettled([
        k.receivables.recordPayment(payment, HUMAN),
        k.receivables.recordPayment(payment, HUMAN),
      ]);
      const succeeded = attempts.filter((entry) => entry.status === "fulfilled").length;
      const final = await k.receivables.getById(receivable.id);
      const paid = final.paidAmount.amount;
      const detail = `第 ${round}/${PAYMENT_ROUNDS} 轮（应收 ${RECEIVABLE_CENTS} 分）：回执成功 ${succeeded}/2 笔，账本 paidAmount=${paid} 分`;

      // 本 issue 的核心不变式：绝不允许「两条回执都成功、账本只记一笔」。
      expect(
        succeeded === 2 && paid === PAYMENT_CENTS,
        `并发丢账：${detail} —— 两笔收款都返回成功，但账本只记了一笔，有一笔真实回款在台账里消失`,
      ).toBe(false);
      // 每一笔返回成功的收款都必须体现在账本上。
      expect(
        paid,
        `账实不符：${detail} —— 成功 ${succeeded} 笔应记 ${succeeded * PAYMENT_CENTS} 分，账本却是 ${paid} 分`,
      ).toBe(succeeded * PAYMENT_CENTS);
      // 无论并发怎么排，账本都不能超过应收总额。
      expect(
        paid,
        `超额入账：${detail} —— paidAmount 不得超过应收总额 ${RECEIVABLE_CENTS} 分`,
      ).toBeLessThanOrEqual(RECEIVABLE_CENTS);
    }
  }, 60_000);

  // 挂起：依赖 WAN-96（quotes.service.ts 的确认/驳回必须串行化且互斥）。
  it.skipIf(SUSPENDED_UNTIL_FIXED["WAN-96"])(
    `并发重复确认：同一报价草稿并发两次 confirm 只允许一次成功（${CONFIRM_ROUNDS} 轮）`,
    async () => {
      const { db: conn, kernel: k } = requireDb();

      for (let round = 1; round <= CONFIRM_ROUNDS; round += 1) {
        const quoteId = await seedDraft(k, `CONF-${suffix()}`, 30_000);
        const attempts = await Promise.allSettled([
          k.quotes.confirmDraft(quoteId, HUMAN),
          k.quotes.confirmDraft(quoteId, HUMAN),
        ]);
        const succeeded = attempts.filter((entry) => entry.status === "fulfilled").length;
        const row = await quoteRow(conn, k.tenantId, quoteId);
        const audits = await auditCount(conn, k.tenantId, quoteId, "QUOTE_CONFIRMED");
        const detail = `第 ${round}/${CONFIRM_ROUNDS} 轮：回执成功 ${succeeded}/2 次，状态=${row?.status}，QUOTE_CONFIRMED 审计 ${audits} 条`;

        expect(
          succeeded,
          `并发重复确认：${detail} —— 同一张草稿被批准了两次，审批窗口的「不可重复决策」被并发击穿`,
        ).toBe(1);
        expect(
          audits,
          `重复审计：${detail} —— 成功几次就该有几条确认审计，重复的审计会让事后对账无法还原`,
        ).toBe(succeeded);
        expect(row?.status, `状态错误：${detail} —— 一次成功批准后草稿必须是 SENT`).toBe("SENT");
      }
    },
    60_000,
  );

  // 挂起：依赖 WAN-96（confirm 与 reject 并发时只允许一个成功、不留矛盾行）。
  it.skipIf(SUSPENDED_UNTIL_FIXED["WAN-96"])(
    `并发 confirm + reject：不得出现 REJECTED 却带 confirmedBy 的矛盾行（${DECISION_ROUNDS} 轮）`,
    async () => {
      const { db: conn, kernel: k } = requireDb();

      for (let round = 1; round <= DECISION_ROUNDS; round += 1) {
        const quoteId = await seedDraft(k, `CR-${suffix()}`, 30_000);
        const attempts = await Promise.allSettled([
          k.quotes.confirmDraft(quoteId, HUMAN),
          k.quotes.rejectDraft(quoteId, HUMAN, "并发驳回"),
        ]);
        const succeeded = attempts.filter((entry) => entry.status === "fulfilled").length;
        const row = await quoteRow(conn, k.tenantId, quoteId);
        const confirmedAudits = await auditCount(conn, k.tenantId, quoteId, "QUOTE_CONFIRMED");
        const rejectedAudits = await auditCount(conn, k.tenantId, quoteId, "QUOTE_REJECTED");
        const detail = `第 ${round}/${DECISION_ROUNDS} 轮：回执成功 ${succeeded}/2 次，状态=${row?.status}，confirmedBy=${row?.confirmedBy ?? "null"}，确认审计 ${confirmedAudits} 条 / 驳回审计 ${rejectedAudits} 条`;

        // 本 issue 指定的矛盾状态：驳回的行却写着是谁确认的。
        expect(
          row?.status === "REJECTED" && row?.confirmedBy != null,
          `矛盾状态行：${detail} —— 该行既是 REJECTED 又带着 confirmedBy，账本自相矛盾，事后无法判断这张报价到底生效没有`,
        ).toBe(false);
        expect(succeeded, `决策冲突：${detail} —— 确认与驳回是互斥决策，不能两次都成功`).toBe(1);
        expect(
          confirmedAudits + rejectedAudits,
          `审计与回执不一致：${detail} —— 每次成功决策对应一条审计，出现「改了账但审计对不上」`,
        ).toBe(succeeded);
        expect(
          row?.status === "REJECTED" ? rejectedAudits : confirmedAudits,
          `状态与审计不匹配：${detail} —— 最终状态是 ${row?.status}，对应审计必须恰好一条`,
        ).toBe(1);
      }
    },
    60_000,
  );
});
