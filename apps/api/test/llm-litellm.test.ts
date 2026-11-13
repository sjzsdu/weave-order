import { describe, expect, it, vi } from "vitest";
import { LiteLlmProvider, LocalRuleLlmProvider, createLlmProvider } from "../src/platform/llm";
import type { LlmUsageSink } from "../src/platform/llm";
import { redactSensitiveText } from "../src/platform/privacy";
import type { LlmBudgetStatus, ResolvedLlmSettings } from "@weave-order/schema";

const settings: ResolvedLlmSettings = {
  provider: "litellm",
  baseUrl: "http://litellm.test:4000",
  defaultModel: "deepseek-chat",
  reasoningModel: "deepseek-reasoner",
  modelAllowlist: ["deepseek-chat", "deepseek-reasoner"],
  dailyTokenBudget: null,
  monthlyTokenBudget: null,
  params: {},
  keyRef: "TENANT_KEY",
  allowExternal: true,
  logPrompts: false,
  version: 1,
  sources: {},
};

function budget(exceeded = false): LlmBudgetStatus {
  return {
    period: "2026-11",
    dailyTokens: exceeded ? 100 : 0,
    monthlyTokens: exceeded ? 100 : 0,
    dailyBudget: exceeded ? 100 : null,
    monthlyBudget: exceeded ? 100 : null,
    dailyExceeded: exceeded,
    monthlyExceeded: exceeded,
  };
}

function sink(exceeded = false) {
  const settle = vi.fn().mockResolvedValue(undefined);
  const fail = vi.fn().mockResolvedValue(undefined);
  const reserve = vi.fn().mockResolvedValue({ allowed: !exceeded, status: budget(exceeded) });
  const usage: LlmUsageSink = {
    reserve,
    settle,
    fail,
    budgetStatus: () => Promise.resolve(budget(exceeded)),
  };
  return { usage, reserve, settle, fail };
}

describe("LiteLLM provider", () => {
  it("只请求 LITELLM_BASE_URL，带租户 key / request_id，并幂等记账", async () => {
    const { usage, reserve, settle, fail } = sink();
    const body = {
      id: "chatcmpl-1",
      model: "deepseek-chat",
      choices: [
        {
          message: {
            content: JSON.stringify({
              productKeywords: ["汗布"],
              composition: "棉",
              weight: "220g/m2",
              quantity: { value: 500, unit: "meter" },
              priceRequested: true,
              deliveryDate: null,
              confidence: 0.9,
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }) as unknown as typeof fetch;

    const provider = new LiteLlmProvider({
      settings,
      usage,
      apiKey: "sk-tenant-1",
      timeoutMs: 1000,
      fetchImpl,
      now: () => new Date("2026-11-12T00:00:00.000Z"),
    });

    const intent = await provider.extractQuoteIntent({
      text: "这款 220g 棉的，要 500 米，什么价，我的手机 13800138000",
    });

    expect(intent.slots.quantity).toEqual({ value: 500, unit: "meter" });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://litellm.test:4000/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-tenant-1");
    expect((init.headers as Record<string, string>)["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    // 出网前脱敏：手机号不出现原文。
    const sentBody = JSON.stringify(init.body);
    expect(sentBody).not.toContain("13800138000");
    expect(sentBody).toContain("[PHONE:");
    // 先预留再结算：调用前占预算，成功后按实际 usage 结算。
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1);
    const settled = settle.mock.calls[0]?.[0] as {
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
    };
    expect(settled.promptTokens).toBe(120);
    expect(settled.completionTokens).toBe(30);
    expect(settled.cachedTokens).toBe(10);
    const reserved = reserve.mock.calls[0]?.[0] as { promptHash: string; reservedTokens: number };
    expect(reserved.promptHash).toHaveLength(64);
    expect(reserved.reservedTokens).toBeGreaterThan(0);
    expect(provider.lastUsage?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("模型不在白名单 / 预算用尽时拒绝调用，不发外网请求", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const noBudget = sink(true);
    const provider = new LiteLlmProvider({
      settings,
      usage: noBudget.usage,
      apiKey: "sk",
      timeoutMs: 1000,
      fetchImpl,
    });
    await expect(provider.extractQuoteIntent({ text: "棉 500 米" })).rejects.toThrow(/预算/);
    expect(fetchImpl).not.toHaveBeenCalled();

    const { usage } = sink();
    const deny = new LiteLlmProvider({
      settings: { ...settings, modelAllowlist: ["qwen-plus"] },
      usage,
      apiKey: "sk",
      timeoutMs: 1000,
      fetchImpl,
    });
    await expect(deny.extractQuoteIntent({ text: "棉 500 米" })).rejects.toThrow(/白名单/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("超时 / 5xx / 空回复三条失败路径都走 fail 计量，不让用量归零", async () => {
    const cases: {
      name: string;
      fetchImpl: typeof fetch;
      expected: { promptTokens?: number; completionTokens?: number } | undefined;
    }[] = [
      {
        name: "超时",
        fetchImpl: vi
          .fn()
          .mockRejectedValue(new DOMException("The operation timed out", "AbortError")),
        expected: undefined,
      },
      {
        name: "5xx",
        fetchImpl: vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: () => Promise.resolve("upstream unavailable"),
        }),
        expected: undefined,
      },
      {
        name: "空回复",
        fetchImpl: vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: "" } }],
              usage: { prompt_tokens: 40, completion_tokens: 0 },
            }),
        }),
        expected: { promptTokens: 40, completionTokens: 0 },
      },
    ];

    for (const testCase of cases) {
      const { usage, reserve, settle, fail } = sink();
      const provider = new LiteLlmProvider({
        settings,
        usage,
        apiKey: "sk",
        timeoutMs: 1000,
        fetchImpl: testCase.fetchImpl,
      });

      await expect(provider.extractQuoteIntent({ text: "棉 500 米" })).rejects.toThrow();
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledTimes(1);
      const failed = fail.mock.calls[0]?.[0] as {
        requestId: string;
        promptTokens?: number;
        completionTokens?: number;
      };
      expect(failed.requestId).toMatch(/^[0-9a-f-]{36}$/);
      if (testCase.expected) {
        expect(failed.promptTokens).toBe(testCase.expected.promptTokens);
        expect(failed.completionTokens).toBe(testCase.expected.completionTokens);
      }
    }
  });
});

describe("本地规则槽位抽取（零 key 降级路径）", () => {
  it("中文原话解析出成分 / 克重 / 数量 / 询价意图", async () => {
    const provider = new LocalRuleLlmProvider();
    const intent = await provider.extractQuoteIntent({
      text: "这款 220g 棉的，要 500 米，什么价",
    });
    expect(intent.slots.composition).toBe("棉");
    expect(intent.slots.weight).toBe("220g");
    expect(intent.slots.quantity).toEqual({ value: 500, unit: "meter" });
    expect(intent.slots.priceRequested).toBe(true);
    expect(provider.lastUsage).toBeNull();
  });

  it("敏感字段脱敏保留末四位，不泄原文", () => {
    const redacted = redactSensitiveText(
      "电话 13800138000，邮箱 a@b.com，账号 6222021234567890123",
    );
    expect(redacted).not.toContain("13800138000");
    expect(redacted).not.toContain("a@b.com");
    expect(redacted).not.toContain("6222021234567890123");
    expect(redacted).toContain("8000");
  });
});

describe("LiteLLM 模型路由与生产密钥 fail-fast", () => {
  it("长客户原话升级到 reasoner，短文本用 daily 模型", async () => {
    const { usage } = sink();
    const models: string[] = [];
    const fetchImpl = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
        model: string;
      };
      models.push(body.model);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            model: "deepseek-reasoner",
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
                    confidence: 0.8,
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
      });
    }) as unknown as typeof fetch;
    const provider = new LiteLlmProvider({
      settings,
      usage,
      apiKey: "sk",
      timeoutMs: 1000,
      fetchImpl,
    });

    await provider.extractQuoteIntent({ text: "棉 500 米" });
    await provider.extractQuoteIntent({ text: `棉 500 米 ${"很长的规格说明".repeat(200)}` });
    expect(models[0]).toBe("deepseek-chat");
    expect(models[1]).toBe("deepseek-reasoner");
  });

  it("生产环境 keyRef 未命中 env 直接拒绝；不接受 sk-local-dev", () => {
    const { usage } = sink();
    const env = {
      NODE_ENV: "production" as const,
      LITELLM_MASTER_KEY: "sk-production",
      LITELLM_TIMEOUT_MS: 1000,
    };
    expect(() =>
      createLlmProvider("litellm", {
        settings: { ...settings, keyRef: "TENANT_KEY_NOT_SET" },
        usage,
        env,
      }),
    ).toThrow(/keyRef/);

    expect(() =>
      createLlmProvider("litellm", {
        settings: { ...settings, keyRef: "LITELLM_MASTER_KEY" },
        usage,
        env: { ...env, LITELLM_MASTER_KEY: "sk-local-dev" },
      }),
    ).toThrow(/dev 默认值/);

    expect(
      createLlmProvider("litellm", {
        settings,
        usage,
        env: { ...env, NODE_ENV: "development" },
      }).name,
    ).toBe("litellm");
  });
});
