import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalRuleLlmProvider,
  OpenAiCompatibleProvider,
  createLlmProvider,
  isAllowedLlmKeyRef,
} from "../src/platform/llm";
import type { LlmUsageSink } from "../src/platform/llm";
import { DEV_LLM_API_KEY } from "../src/platform/env";
import { redactSensitiveText } from "../src/platform/privacy";
import type { LlmBudgetStatus, ResolvedLlmSettings } from "@weave-order/schema";

const settings: ResolvedLlmSettings = {
  provider: "openai-compatible",
  baseUrl: "https://gateway.example.test/v1",
  defaultModel: "daily-model",
  reasoningModel: "reason-model",
  modelAllowlist: ["daily-model", "reason-model", "vision-model"],
  dailyTokenBudget: null,
  monthlyTokenBudget: null,
  params: {},
  keyRef: "LLM_API_KEY",
  allowExternal: true,
  logPrompts: false,
  version: 1,
  sources: {},
};

const prodEnv = {
  NODE_ENV: "production" as const,
  AUTH_MODE: "oidc" as const,
  LLM_BASE_URL: "https://gateway.example.test/v1",
  LLM_API_KEY: "sk-gateway-test",
  LLM_TIMEOUT_MS: 1000,
  LLM_VISION_MODEL: "vision-model",
};

const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

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

function chatReply(model = "daily-model") {
  return {
    id: "chatcmpl-1",
    model,
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
}

function providerWith(
  fetchImpl: typeof fetch,
  override: Partial<ResolvedLlmSettings> = {},
  usage: LlmUsageSink = sink().usage,
) {
  return new OpenAiCompatibleProvider({
    settings: { ...settings, ...override },
    usage,
    apiKey: "sk-gateway-test",
    timeoutMs: 1000,
    visionModel: "vision-model",
    fetchImpl,
    now: () => new Date("2026-11-12T00:00:00.000Z"),
  });
}

describe("OpenAiCompatibleProvider · 任意企业网关", () => {
  it("任意 baseUrl 都拼接 /chat/completions；Bearer Key / request_id / 脱敏 / 幂等计量", async () => {
    const { usage, reserve, settle, fail } = sink();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(chatReply()) }) as unknown as typeof fetch;

    const provider = providerWith(fetchImpl, {}, usage);
    const intent = await provider.extractQuoteIntent({
      text: "这款 220g 棉的，要 500 米，什么价，我的手机 13800138000",
    });

    expect(intent.slots.quantity).toEqual({ value: 500, unit: "meter" });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://gateway.example.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-gateway-test");
    expect((init.headers as Record<string, string>)["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const sentBody = JSON.stringify(init.body);
    expect(sentBody).not.toContain("13800138000");
    expect(sentBody).toContain("[PHONE:");
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
    expect(provider.name).toBe("openai-compatible");
  });

  it("baseUrl 结尾斜杠不会产生双斜杠；换网关地址只改配置", async () => {
    for (const baseUrl of [
      "https://other-gateway.example.com/v1",
      "https://other-gateway.example.com/v1/",
      "https://other-gateway.example.com/v1///",
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(chatReply()),
      }) as unknown as typeof fetch;
      const provider = providerWith(fetchImpl, { baseUrl }, sink().usage);
      await provider.extractQuoteIntent({ text: "棉 500 米" });
      expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
        "https://other-gateway.example.com/v1/chat/completions",
      );
    }
  });

  it("模型不在白名单 / 预算用尽时拒绝调用，不发外网请求", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const noBudget = sink(true);
    const provider = providerWith(fetchImpl, {}, noBudget.usage);
    await expect(provider.extractQuoteIntent({ text: "棉 500 米" })).rejects.toThrow(/预算/);
    expect(fetchImpl).not.toHaveBeenCalled();

    const deny = providerWith(fetchImpl, { modelAllowlist: ["other-model"] }, sink().usage);
    await expect(deny.extractQuoteIntent({ text: "棉 500 米" })).rejects.toThrow(/白名单/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("超时 / 5xx / 空回复三条失败路径都走 fail 计量", async () => {
    const cases: {
      name: string;
      fetchImpl: typeof fetch;
      expected: { promptTokens?: number; completionTokens?: number } | undefined;
    }[] = [
      {
        name: "超时",
        fetchImpl: vi.fn().mockRejectedValue(new DOMException("timed out", "AbortError")),
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
      const provider = providerWith(testCase.fetchImpl, {}, usage);
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

describe("截图识别（SCREENSHOT_OCR 多模态）", () => {
  it("视觉模型来自配置，image_url 多模态格式不回归", async () => {
    const { usage, reserve, settle, fail } = sink();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "chatcmpl-img-1",
          model: "vision-model",
          choices: [{ message: { content: JSON.stringify({ text: "这款 220g 棉的多少钱？" }) } }],
          usage: { prompt_tokens: 1500, completion_tokens: 40 },
        }),
    }) as unknown as typeof fetch;

    const provider = providerWith(fetchImpl, {}, usage);
    const result = await provider.extractReplyFromImage({ imageUrl: "data:image/png;base64,AAAA" });

    expect(result.text).toBe("这款 220g 棉的多少钱？");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://gateway.example.test/v1/chat/completions");
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    expect(body.model).toBe("vision-model");
    const userMsg = body.messages.find((m) => m.role === "user");
    expect(JSON.stringify(userMsg?.content)).toContain("image_url");
    expect(JSON.stringify(userMsg?.content)).toContain("data:image/png;base64,AAAA");
    const reserved = reserve.mock.calls[0]?.[0] as { task: string; reservedTokens: number };
    expect(reserved.task).toBe("SCREENSHOT_OCR");
    expect(reserved.reservedTokens).toBeGreaterThanOrEqual(1105 + 1024);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
    expect(provider.lastUsage?.task).toBe("SCREENSHOT_OCR");
  });

  it("视觉模型不在白名单时拒绝调用", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = providerWith(
      fetchImpl,
      { modelAllowlist: ["daily-model", "reason-model"] },
      sink().usage,
    );
    await expect(provider.extractReplyFromImage({ imageUrl: "x" })).rejects.toThrow(/白名单/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("本地规则实现读不了图，直接拒绝", async () => {
    const provider = new LocalRuleLlmProvider();
    await expect(provider.extractReplyFromImage({ imageUrl: "x" })).rejects.toThrow(/企业模型网关/);
  });
});

describe("本地规则槽位抽取（零 key 降级路径）", () => {
  it("中文原话解析出成分 / 克重 / 数量 / 询价意图", async () => {
    const provider = new LocalRuleLlmProvider();
    const intent = await provider.extractQuoteIntent({ text: "这款 220g 棉的，要 500 米，什么价" });
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

  it("allowExternal=false 时调用方直接选 local-rule（无需网关配置）", () => {
    const provider = createLlmProvider("local-rule");
    expect(provider.name).toBe("local-rule-v1");
  });
});

describe("模型路由与 Key 引用", () => {
  it("长客户原话升级到 reasoningModel，短文本用 defaultModel", async () => {
    const models: string[] = [];
    const fetchImpl = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
        model: string;
      };
      models.push(body.model);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(chatReply(body.model)) });
    }) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl, {}, sink().usage);

    await provider.extractQuoteIntent({ text: "棉 500 米" });
    await provider.extractQuoteIntent({ text: `棉 500 米 ${"很长的规格说明".repeat(200)}` });
    expect(models[0]).toBe("daily-model");
    expect(models[1]).toBe("reason-model");
  });

  it("LLM_API_KEY 与 LLM_TENANT_KEY_<名称> 都可用，Bearer 取对应令牌", async () => {
    setEnv("LLM_TENANT_KEY_T_0001", "sk-tenant-test");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(chatReply()),
    }) as unknown as typeof fetch;
    for (const [keyRef, expected] of [
      ["LLM_API_KEY", "Bearer sk-gateway-test"],
      ["LLM_TENANT_KEY_T_0001", "Bearer sk-tenant-test"],
    ] as const) {
      const provider = createLlmProvider("openai-compatible", {
        settings: { ...settings, keyRef },
        usage: sink().usage,
        env: { ...prodEnv, LLM_API_KEY: "sk-gateway-test" },
        fetchImpl,
      });
      await provider.extractQuoteIntent({ text: "棉 500 米" });
      const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [
        string,
        RequestInit,
      ][];
      const init = calls[calls.length - 1]?.[1];
      expect((init?.headers as Record<string, string>).authorization).toBe(expected);
    }
  });

  it("Key 引用白名单拒绝 LITELLM_* / DATABASE_URL / 任意环境变量名", () => {
    expect(isAllowedLlmKeyRef("LLM_API_KEY")).toBe(true);
    expect(isAllowedLlmKeyRef("LLM_TENANT_KEY_T_0001")).toBe(true);
    for (const name of [
      "LITELLM_MASTER_KEY",
      "LITELLM_TENANT_KEY_T_0001",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "LLM_TENANT_KEY",
      "LLM_API_KEYX",
    ]) {
      expect(isAllowedLlmKeyRef(name)).toBe(false);
    }
    expect(() =>
      createLlmProvider("openai-compatible", {
        settings: { ...settings, keyRef: "DATABASE_URL" },
        usage: sink().usage,
        env: prodEnv,
      }),
    ).toThrow(/白名单/);
  });
});

describe("生产 fail closed", () => {
  const usage = sink().usage;

  it("缺 LLM_BASE_URL、缺 Key、占位 Key、Key 引用未命中都拒绝创建 provider", () => {
    setEnv("LLM_API_KEY", undefined);
    expect(() =>
      createLlmProvider("openai-compatible", {
        settings: { ...settings, baseUrl: "" },
        usage,
        env: { ...prodEnv, LLM_BASE_URL: undefined },
      }),
    ).toThrow(/LLM_BASE_URL/);
    expect(() =>
      createLlmProvider("openai-compatible", {
        settings,
        usage,
        env: { ...prodEnv, LLM_API_KEY: undefined },
      }),
    ).toThrow(/LLM_API_KEY/);
    expect(() =>
      createLlmProvider("openai-compatible", {
        settings,
        usage,
        env: { ...prodEnv, LLM_API_KEY: DEV_LLM_API_KEY },
      }),
    ).toThrow(/占位/);
    expect(() =>
      createLlmProvider("openai-compatible", {
        settings: { ...settings, keyRef: "LLM_TENANT_KEY_T_9999" },
        usage,
        env: prodEnv,
      }),
    ).toThrow(/未命中/);
  });

  it("local-rule 不需要任何网关配置；开发态允许占位 key", () => {
    expect(createLlmProvider("local-rule").name).toBe("local-rule-v1");
    const provider = createLlmProvider("openai-compatible", {
      settings,
      usage,
      env: { ...prodEnv, NODE_ENV: "development", AUTH_MODE: "dev", LLM_API_KEY: DEV_LLM_API_KEY },
    });
    expect(provider.name).toBe("openai-compatible");
  });

  it("未知 provider 明确报错", () => {
    expect(() => createLlmProvider("oneapi")).toThrow(/不受支持/);
  });
});

describe("llm_settings 的 LLM_* 环境变量 fallback", () => {
  it("没有已保存设置时，模型 / baseUrl / 白名单都来自通用环境变量", async () => {
    const { LlmSettingsService } = await import("../src/kernel/llm-settings.service");
    setEnv("NODE_ENV", "development");
    setEnv("AUTH_MODE", "dev");
    setEnv("LLM_BASE_URL", "https://gateway.example.test/v1");
    setEnv("LLM_DEFAULT_MODEL", "env-daily");
    setEnv("LLM_REASONING_MODEL", "env-reason");
    setEnv("LLM_VISION_MODEL", "env-vision");
    setEnv("LLM_MODEL_ALLOWLIST", "env-daily,env-reason,env-vision");
    const fakeDb = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    } as unknown as ConstructorParameters<typeof LlmSettingsService>[0];

    const resolved = await new LlmSettingsService(fakeDb, "11111111-1111-1111-1111-111111111111").resolve();
    expect(resolved.baseUrl).toBe("https://gateway.example.test/v1");
    expect(resolved.defaultModel).toBe("env-daily");
    expect(resolved.reasoningModel).toBe("env-reason");
    expect(resolved.modelAllowlist).toEqual(["env-daily", "env-reason", "env-vision"]);
    expect(resolved.keyRef).toBe("LLM_API_KEY");
    expect(resolved.sources.defaultModel).toBe("ENV");
  });
});
