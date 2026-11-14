import { createDb, tokenUsage } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { ResolvedLlmSettings } from "@weave-order/schema";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LiteLlmProvider } from "../src/platform/llm";
import type { LlmUsageSink } from "../src/platform/llm";
import { UsageService } from "../src/kernel/usage.service";

/**
 * WAN-101：LLM 预算「预留—结算」的并发与失败计量回归。
 *
 * 真实 PostgreSQL：预算判断 + 预留必须原子，否则 N 个并发请求各自读到同一份
 * 「已用 X/预算 Y」全部放行。用例先在无预算租户上校准一次预留上限，
 * 再用 N*3 预算并发发起 N+5 个请求，断言放行数量受预算约束且实际消耗不超预算。
 *
 * 失败路径（超时 / 5xx / 空回复）必须在 `token_usage` 留下 FAILED 行。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";

const ACTUAL_PROMPT_TOKENS = 120;
const ACTUAL_COMPLETION_TOKENS = 30;
const CONCURRENT_REQUESTS = 8;

/**
 * 预算按 UTC 日界 / 月界取窗口，夹具时钟与查询时钟必须是同一个瞬间：
 * 写死历史日期会在跨天后（预留行落在旧日、`budgetStatus` 读当日窗口）必然读不到用量，
 * 跨月后 `monthlyByTask` 同理。统一取运行时的一次 `new Date()`，两者永远同窗。
 */
const FIXED_AT = new Date();
const fixedClock = () => FIXED_AT;

let handle: ReturnType<typeof createDb> | null = null;
let db: Db | null = null;

beforeAll(async () => {
  const created = createDb(DATABASE_URL);
  try {
    const probe = await created.pool.query<{ status: boolean; reserved: boolean }>(
      `SELECT to_regclass('public.token_usage') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'token_usage' AND column_name = 'status'
              ) AS status,
              EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'token_usage' AND column_name = 'reserved_tokens'
              ) AS reserved`,
    );
    if (probe.rows[0]?.status !== true || probe.rows[0]?.reserved !== true) {
      throw new Error("token_usage 缺少 status / reserved_tokens 列，迁移尚未执行");
    }
  } catch (error) {
    await created.pool.end();
    throw new Error(
      `[LLM 预算回归] 需要 PostgreSQL（${DATABASE_URL}）才能运行，但探测失败：${
        error instanceof Error ? error.message : String(error)
      }。本用例禁止静默跳过——请先 docker compose up -d && pnpm db:migrate。`,
    );
  }
  handle = created;
  db = created.db;
});

afterAll(async () => {
  await handle?.pool.end();
  handle = null;
  db = null;
});

function requireDb(): Db {
  if (!db) throw new Error("[LLM 预算回归] 前置失败：PostgreSQL 不可用");
  return db;
}

function settingsWith(
  dailyTokenBudget: number | null,
  monthlyTokenBudget: number | null = null,
): ResolvedLlmSettings {
  return {
    provider: "litellm",
    baseUrl: "http://litellm.test:4000",
    defaultModel: "deepseek-chat",
    reasoningModel: "deepseek-reasoner",
    modelAllowlist: ["deepseek-chat", "deepseek-reasoner"],
    dailyTokenBudget,
    monthlyTokenBudget,
    params: {},
    keyRef: "LITELLM_MASTER_KEY",
    allowExternal: true,
    logPrompts: false,
    version: 1,
    sources: {},
  };
}

function successfulFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        model: "deepseek-chat",
        choices: [
          {
            message: {
              content: JSON.stringify({
                productKeywords: ["棉"],
                composition: "棉",
                weight: null,
                quantity: { value: 500, unit: "meter" },
                priceRequested: true,
                deliveryDate: null,
                confidence: 0.9,
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: ACTUAL_PROMPT_TOKENS,
          completion_tokens: ACTUAL_COMPLETION_TOKENS,
        },
      }),
  });
}

function trackedUsage(
  tenantId: string,
  onReserve?: (reservedTokens: number) => void,
): LlmUsageSink {
  const service = new UsageService(requireDb(), tenantId);
  return {
    reserve: async (input) => {
      onReserve?.(input.reservedTokens);
      return service.reserve(input);
    },
    settle: (input) => service.settle(input),
    fail: (input) => service.fail(input),
    budgetStatus: (daily, monthly) => service.budgetStatus(daily, monthly, FIXED_AT),
  };
}

async function rowsOf(tenantId: string) {
  return requireDb().select().from(tokenUsage).where(eq(tokenUsage.tenantId, tenantId));
}

describe("LLM 预算预留—结算", () => {
  it("预算约束下并发请求不会超支，放行数量受预留上限限制", async () => {
    // 1) 无预算租户上校准一次「预留上限」：与实际 usage 无关，只取决于 prompt 长度。
    const calibrationTenant = randomUUID();
    let reservedPerCall = 0;
    const calibration = new LiteLlmProvider({
      settings: settingsWith(null),
      usage: trackedUsage(calibrationTenant, (tokens) => {
        reservedPerCall = tokens;
      }),
      apiKey: "sk",
      timeoutMs: 1000,
      fetchImpl: successfulFetch(),
      now: fixedClock,
    });
    await calibration.extractQuoteIntent({ text: "棉 500 米" });
    expect(reservedPerCall).toBeGreaterThan(ACTUAL_PROMPT_TOKENS + ACTUAL_COMPLETION_TOKENS);

    // 2) 预算 = 3 次预留上限；并发发起 8 个请求（>3），最多只能放行 3 个。
    const tenantId = randomUUID();
    const expectedAdmitted = 3;
    const budget = reservedPerCall * expectedAdmitted;
    const settings = settingsWith(budget);

    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fetchImpl = vi.fn(async () => {
      // 卡住已放行的调用，等所有预留尝试结束，构造「全部同时读到旧值」的最坏并发。
      await gate;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            model: "deepseek-chat",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    productKeywords: ["棉"],
                    composition: "棉",
                    weight: null,
                    quantity: { value: 500, unit: "meter" },
                    priceRequested: true,
                    deliveryDate: null,
                    confidence: 0.9,
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: ACTUAL_PROMPT_TOKENS,
              completion_tokens: ACTUAL_COMPLETION_TOKENS,
            },
          }),
      };
    }) as unknown as typeof fetch;

    const usage: LlmUsageSink = {
      reserve: async (input) => {
        try {
          return await trackedUsage(tenantId).reserve(input);
        } finally {
          // 等 8 个预留决策全部落地再放行 fetch：否则先放行的调用会先结算，
          // 提前释放额度，测不出「同时读到旧值」的并发缺口。
          attempts += 1;
          if (attempts === CONCURRENT_REQUESTS) release();
        }
      },
      settle: (input) => trackedUsage(tenantId).settle(input),
      fail: (input) => trackedUsage(tenantId).fail(input),
      budgetStatus: (daily, monthly) => trackedUsage(tenantId).budgetStatus(daily, monthly),
    };

    const provider = new LiteLlmProvider({
      settings,
      usage,
      apiKey: "sk",
      timeoutMs: 1000,
      fetchImpl,
      now: fixedClock,
    });

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        provider
          .extractQuoteIntent({ text: "棉 500 米" })
          .then(() => "admitted" as const)
          .catch((error: unknown) => error),
      ),
    );

    const admitted = results.filter((result) => result === "admitted").length;
    const rejected = results.filter((result) => result !== "admitted");
    expect(admitted).toBe(expectedAdmitted);
    expect(rejected).toHaveLength(CONCURRENT_REQUESTS - expectedAdmitted);
    for (const error of rejected) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/预算/);
    }
    // 被预算挡下的请求不允许出网，也不留用量行。
    expect(fetchImpl).toHaveBeenCalledTimes(expectedAdmitted);

    const rows = await rowsOf(tenantId);
    expect(rows).toHaveLength(expectedAdmitted);
    expect(rows.every((row) => row.status === "SETTLED")).toBe(true);
    const actualTokens = rows.reduce(
      (sum, row) => sum + row.promptTokens + row.completionTokens,
      0,
    );
    expect(actualTokens).toBe(expectedAdmitted * (ACTUAL_PROMPT_TOKENS + ACTUAL_COMPLETION_TOKENS));
    expect(actualTokens).toBeLessThanOrEqual(budget);

    // 预算快照同样把已结算的实际用量算进去。
    const status = await new UsageService(requireDb(), tenantId).budgetStatus(
      budget,
      null,
      FIXED_AT,
    );
    expect(status.dailyTokens).toBe(actualTokens);
    expect(status.dailyExceeded).toBe(false);
  });

  it("超时 / 5xx / 空回复各留一条 FAILED 用量行，且计入预算", async () => {
    const cases: { name: string; fetchImpl: typeof fetch; promptTokens: number }[] = [
      {
        name: "超时",
        fetchImpl: vi
          .fn()
          .mockRejectedValue(new DOMException("The operation timed out", "AbortError")),
        promptTokens: 0,
      },
      {
        name: "5xx",
        fetchImpl: vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: () => Promise.resolve("upstream unavailable"),
        }),
        promptTokens: 0,
      },
      {
        name: "空回复",
        fetchImpl: vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              model: "deepseek-chat",
              choices: [{ message: { content: "" } }],
              usage: { prompt_tokens: 64, completion_tokens: 0 },
            }),
        }),
        promptTokens: 64,
      },
    ];

    for (const testCase of cases) {
      const tenantId = randomUUID();
      const service = new UsageService(requireDb(), tenantId);
      const provider = new LiteLlmProvider({
        settings: settingsWith(null),
        usage: {
          reserve: (input) => service.reserve(input),
          settle: (input) => service.settle(input),
          fail: (input) => service.fail(input),
          budgetStatus: (daily, monthly) => service.budgetStatus(daily, monthly, FIXED_AT),
        },
        apiKey: "sk",
        timeoutMs: 1000,
        fetchImpl: testCase.fetchImpl,
        now: fixedClock,
      });

      await expect(provider.extractQuoteIntent({ text: "棉 500 米" })).rejects.toThrow();

      const rows = await rowsOf(tenantId);
      expect(rows, `${testCase.name} 应落库`).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe("FAILED");
      // 上游失败可能已产生费用：预留额度保留，预算不被绕过。
      expect(row.reservedTokens).toBeGreaterThan(0);
      expect(row.promptTokens).toBe(testCase.promptTokens);

      const status = await service.budgetStatus(null, null, FIXED_AT);
      expect(status.dailyTokens).toBe(row.reservedTokens);
    }
  });

  it("同一 request_id 重复结算不重复累加月度用量", async () => {
    const tenantId = randomUUID();
    const service = new UsageService(requireDb(), tenantId);
    const requestId = randomUUID();
    const reservation = await service.reserve({
      requestId,
      task: "QUOTE_INTENT",
      model: "deepseek-chat",
      provider: "litellm",
      promptHash: "a".repeat(64),
      reservedTokens: 500,
      dailyBudget: null,
      monthlyBudget: null,
      at: FIXED_AT,
    });
    expect(reservation.allowed).toBe(true);

    const settleInput = {
      requestId,
      model: "deepseek-chat",
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 0,
      at: FIXED_AT,
    };
    await service.settle(settleInput);
    await service.settle(settleInput);

    const rows = await requireDb()
      .select()
      .from(tokenUsage)
      .where(and(eq(tokenUsage.tenantId, tenantId), eq(tokenUsage.requestId, requestId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("SETTLED");
    expect(rows[0]?.reservedTokens).toBe(0);
    expect(rows[0]?.promptTokens).toBe(100);

    const monthly = await service.monthlyByTask(FIXED_AT);
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({
      task: "QUOTE_INTENT",
      promptTokens: 100,
      completionTokens: 20,
    });
  });
});
