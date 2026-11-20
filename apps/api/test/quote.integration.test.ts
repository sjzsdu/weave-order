import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { createDb } from "@weave-order/db";
import type { DatabaseHandle } from "../src/platform/database";
import { createKernel } from "../src/kernel";
import type { Kernel } from "../src/kernel";
import { LocalRuleLlmProvider } from "../src/platform/llm";
import { createTools } from "../src/tools";
import { createQuoteAgentGraph, toQuoteAgentResult } from "../src/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 报价 agent 集成：真实 PostgreSQL + 内核 + 工具 + token 计量。
 * 没有数据库时跳过（与现有集成测试一致）。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN = { actor: { type: "HUMAN" as const, id: "quote-it" } };

let handle: DatabaseHandle | null = null;
let kernel: Kernel | null = null;
let available = false;

beforeAll(async () => {
  try {
    handle = createDb(DATABASE_URL);
    await handle.pool.query("SELECT 1");
    kernel = createKernel(handle.db);
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  await handle?.pool.end();
});

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

describe("报价 agent（集成）", () => {
  it("原话 → 3 个候选 → DRAFT；token_usage 按 request_id 幂等", async () => {
    if (!available || !kernel) return;
    const id = suffix();
    const customer = await kernel.customers.create(
      { code: `QIT-C-${id}`, name: "报价集成客户", tier: "VIP" },
      HUMAN,
    );
    for (let index = 0; index < 3; index += 1) {
      await kernel.samples.create(
        {
          code: `QIT-S${index}-${id}`,
          name: `220g 棉汗布 ${index}`,
          composition: "100% 棉",
          weight: "220g/m2",
          unit: "meter",
          costFloor: { amount: 1200, currency: "CNY" },
        },
        HUMAN,
      );
    }

    const graph = createQuoteAgentGraph({
      tools: createTools(kernel),
      llm: new LocalRuleLlmProvider(),
      checkpointer: new MemorySaver(),
    });
    const threadId = `quote-it-${id}`;
    const rawText = "这款 220g 棉的，要 500 米，什么价";
    const state = await graph.invoke(
      { threadId, rawText, customerId: customer.id, currency: "CNY", topK: 3 },
      { configurable: { thread_id: threadId } },
    );

    const result = toQuoteAgentResult(state);
    expect(result.status).toBe("DRAFTED");
    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
    expect(result.draft?.status).toBe("DRAFT");
    expect(result.draft?.amountsComputedByKernel).toBe(true);
    expect(result.pricingBasis?.computedBy).toBe("KERNEL");

    const requestId = randomUUID();
    const usageInput = {
      requestId,
      task: "QUOTE_INTENT" as const,
      model: "daily-model",
      provider: "openai-compatible",
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 0,
      costMicros: null,
      promptHash: "a".repeat(64),
    };
    const first = await kernel.usage.record(usageInput);
    const replay = await kernel.usage.record(usageInput);
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.usage.id).toBe(first.usage.id);
    expect(await kernel.usage.getByRequestId(requestId)).not.toBeNull();
  });

  it("llm_settings：全局配置生效，租户可覆盖且写审计", async () => {
    if (!available || !kernel) return;
    // 该用例会写一条 TENANT 覆盖行；复用型本地库若残留上一次的行，
    // 第一次 resolve 就会读到 TENANT 而不是 GLOBAL。跑前跑后各清一次，保证可重复。
    await handle!.pool.query("DELETE FROM llm_settings WHERE tenant_id = $1", [kernel.tenantId]);
    const resolved = await kernel.llmSettings.resolve();
    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.defaultModel.length).toBeGreaterThan(0);
    expect(resolved.reasoningModel.length).toBeGreaterThan(0);
    expect(resolved.sources.defaultModel).toBe("GLOBAL");
    // 历史全局行的 base_url 为空 → 回退 LLM_BASE_URL（未配置即空串，由 provider fail closed）。
    expect(resolved.baseUrl).toBe(process.env.LLM_BASE_URL ?? "");
    expect(resolved.keyRef).toBe("LLM_API_KEY");

    const updated = await kernel.llmSettings.upsertTenant(
      {
        defaultModel: "daily-model",
        reasoningModel: "reason-model",
        modelAllowlist: ["daily-model", "reason-model", "vision-model"],
        dailyTokenBudget: 1_000_000,
        allowExternal: true,
      },
      HUMAN,
    );
    expect(updated.scope).toBe("TENANT");
    expect(updated.dailyTokenBudget).toBe(1_000_000);
    expect(updated.version).toBeGreaterThanOrEqual(1);
    const after = await kernel.llmSettings.resolve();
    expect(after.dailyTokenBudget).toBe(1_000_000);
    expect(after.sources.dailyTokenBudget).toBe("TENANT");

    await expect(
      kernel.llmSettings.upsertTenant({ defaultModel: "model-not-in-allowlist" }, HUMAN),
    ).rejects.toThrow(/白名单/);
    await handle!.pool.query("DELETE FROM llm_settings WHERE tenant_id = $1", [kernel.tenantId]);
  });
});
