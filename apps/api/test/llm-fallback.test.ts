import { describe, expect, it, vi } from "vitest";
import {
  FallbackLlmProvider,
  LocalRuleLlmProvider,
  createResilientLlmProvider,
  humanizeLlmError,
} from "../src/platform/llm";

/**
 * WAN-172：企业模型网关坏掉时，报价链路必须还能跑。
 *
 * 这组断言守两条底线：
 * 1. 主 provider 失败 → 一定回退 local-rule，并产出可用结果（不是抛错）。
 * 2. 降级原因是人话，绝不含网关原文 / request id / 令牌。
 */

const GATEWAY_403 =
  '企业模型网关调用失败：HTTP 403 {"error":{"message":"该令牌无权使用模型：deepseek-chat (request id: 20261119042500abcdef)"}}';

function failingPrimary(error: Error = new Error(GATEWAY_403)) {
  return {
    name: "openai-compatible",
    lastUsage: null,
    suggestFollowup: vi.fn().mockRejectedValue(error),
    classifyReply: vi.fn().mockRejectedValue(error),
    extractQuoteIntent: vi.fn().mockRejectedValue(error),
    extractReplyFromImage: vi.fn().mockRejectedValue(error),
  };
}

describe("报价槽位抽取降级", () => {
  it("网关 403 时回退本地规则并抽出可用槽位", async () => {
    const provider = new FallbackLlmProvider(failingPrimary(), new LocalRuleLlmProvider());

    const intent = await provider.extractQuoteIntent({
      text: "天宝纺织要 220g 棉 500 米，报价",
    });

    expect(intent.provider).toBe("local-rule-v1");
    expect(intent.slots.quantity).toEqual({ value: 500, unit: "meter" });
    expect(intent.slots.weight).toBe("220g");
    expect(intent.slots.priceRequested).toBe(true);
    expect(provider.lastFallback?.task).toBe("QUOTE_INTENT");
  });

  it("降级原因收成人话，不带 request id 与响应体", () => {
    const reason = humanizeLlmError(new Error(GATEWAY_403));
    expect(reason).toContain("HTTP 403");
    expect(reason).toContain("无权使用");
    expect(reason).not.toContain("request id");
    expect(reason).not.toContain("deepseek-chat");
    expect(reason).not.toContain("{");
    expect(new FallbackLlmProvider(failingPrimary()).lastFallback).toBeNull();
  });

  it("主 provider 正常时不降级、不记录原因", async () => {
    const okPrimary = {
      name: "openai-compatible",
      lastUsage: null,
      suggestFollowup: vi.fn(),
      classifyReply: vi.fn(),
      extractQuoteIntent: vi.fn().mockResolvedValue({
        slots: {
          productKeywords: ["棉"],
          composition: "棉",
          weight: "230g",
          quantity: { value: 300, unit: "meter" },
          priceRequested: true,
          deliveryDate: null,
        },
        confidence: 0.9,
        provider: "openai-compatible",
      }),
      extractReplyFromImage: vi.fn(),
    };
    const provider = new FallbackLlmProvider(okPrimary, new LocalRuleLlmProvider());
    const intent = await provider.extractQuoteIntent({ text: "棉 230g 300 米" });
    expect(intent.provider).toBe("openai-compatible");
    expect(provider.lastFallback).toBeNull();
  });
});

describe("resilient 工厂", () => {
  it("openai-compatible 缺配置时不让调用方 500，降级本地规则", async () => {
    const provider = createResilientLlmProvider("openai-compatible", undefined);
    const intent = await provider.extractQuoteIntent({ text: "500 米" });
    expect(intent.provider).toBe("local-rule-v1");
    expect(provider.lastFallback?.reason.length).toBeGreaterThan(0);
  });

  it("local-rule 直接返回本地实现", () => {
    expect(createResilientLlmProvider("local-rule")).toBeInstanceOf(LocalRuleLlmProvider);
  });
});
