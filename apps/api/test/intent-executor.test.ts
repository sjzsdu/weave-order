import { describe, expect, it } from "vitest";
import type { QuoteAgentResult } from "@weave-order/schema";
import { intentOutcomeFromQuoteResult, quoteRawText } from "../src/http/intent-executor.service";

/**
 * 意图执行器的纯映射（WAN-172）。
 *
 * 报价 agent 的三种结局必须各自落到一条真实、可恢复的意图状态：
 * DRAFTED → SUCCEEDED（带审批指针）、NEEDS_INPUT → NEEDS_INPUT（说清缺什么）、
 * FAILED → FAILED（人话原因，原文保留）。
 */

const NOW = "2026-11-19T04:00:00.000Z";

function baseResult(overrides: Partial<QuoteAgentResult>): QuoteAgentResult {
  return {
    threadId: "thread-1",
    stage: "DONE",
    status: "FAILED",
    intent: null,
    candidates: [],
    selectedSampleId: null,
    pricingBasis: null,
    draft: null,
    missingFields: [],
    explanation: "",
    notice: null,
    provider: "local-rule-v1",
    usage: null,
    failure: null,
    ...overrides,
  };
}

const draft = {
  id: "123e4567-e89b-12d3-a456-426614174009",
  tenantId: "00000000-0000-0000-0000-000000000001",
  customerId: "123e4567-e89b-12d3-a456-426614174000",
  status: "DRAFT" as const,
  version: 1,
  currency: "CNY" as const,
  items: [
    {
      fabricSampleId: "123e4567-e89b-12d3-a456-426614174001",
      description: "220g 棉汗布",
      quantity: { value: 500, unit: "meter" as const },
      unitPrice: { amount: 1400, currency: "CNY" as const },
      lineTotal: { amount: 700000, currency: "CNY" as const },
    },
  ],
  subtotal: { amount: 700000, currency: "CNY" as const },
  total: { amount: 700000, currency: "CNY" as const },
  amountsComputedByKernel: true as const,
  validityDays: 30,
  expiresAt: NOW,
  createdAt: NOW,
  remarks: null,
};

describe("报价结果 → 意图结局", () => {
  it("DRAFTED 映射成成功 + 可点的审批指针", () => {
    const outcome = intentOutcomeFromQuoteResult(
      baseResult({ status: "DRAFTED", stage: "DONE", draft }),
    );
    expect(outcome.status).toBe("SUCCEEDED");
    if (outcome.status !== "SUCCEEDED") return;
    expect(outcome.draft.kind).toBe("quote");
    expect(outcome.draft.id).toBe(draft.id);
    expect(outcome.draft.title).toContain(draft.id.slice(0, 8));
  });

  it("NEEDS_INPUT 说清阻断项，并保留降级说明", () => {
    const outcome = intentOutcomeFromQuoteResult(
      baseResult({
        status: "NEEDS_INPUT",
        stage: "NEEDS_INPUT",
        missingFields: [
          { code: "CUSTOMER", label: "客户", prompt: "请选择这条询价属于哪个客户", blocking: true },
          {
            code: "QUANTITY",
            label: "数量",
            prompt: "请补充采购数量（如 500 米）",
            blocking: true,
          },
          { code: "WEIGHT", label: "克重", prompt: "建议补充克重", blocking: false },
        ],
        notice: "模型网关不可用：HTTP 403。本次已用本地规则整理。",
        explanation: "暂未生成草稿",
      }),
    );
    expect(outcome.status).toBe("NEEDS_INPUT");
    if (outcome.status !== "NEEDS_INPUT") return;
    expect(outcome.reason).toContain("客户");
    expect(outcome.reason).toContain("数量");
    expect(outcome.reason).toContain("克重");
    expect(outcome.reason).toContain("HTTP 403");
    expect(outcome.reason).toContain("原话已保留");
  });

  it("FAILED 的人话原因原样保留，网关原文不出现 request id", () => {
    const outcome = intentOutcomeFromQuoteResult(
      baseResult({
        status: "FAILED",
        stage: "FAILED",
        failure: {
          node: "generateDraft",
          code: "KERNEL_REJECTED",
          message: "样品缺少成本底线，无法计算建议价",
          stage: "PRICED",
        },
      }),
    );
    expect(outcome).toEqual({
      status: "FAILED",
      reason: "样品缺少成本底线，无法计算建议价",
    });

    const leaked = intentOutcomeFromQuoteResult(
      baseResult({
        status: "FAILED",
        stage: "FAILED",
        failure: {
          node: "parseIntent",
          code: "LLM_FAILED",
          message: '企业模型网关调用失败：HTTP 403 {"request id":"abc123","message":"no model"}',
          stage: "NEW",
        },
      }),
    );
    expect(leaked.status).toBe("FAILED");
    if (leaked.status !== "FAILED") return;
    expect(leaked.reason).not.toContain("request id");
    expect(leaked.reason).not.toContain("abc123");
    expect(leaked.reason).toContain("HTTP 403");
  });
});

describe("执行器带上的上下文", () => {
  it("样品编号拼进原话，让 agent 命中已选样品", () => {
    expect(quoteRawText("500 米", { sampleCode: "S-001" })).toBe("500 米（样品编号 S-001）");
    expect(quoteRawText("500 米", {})).toBe("500 米");
    expect(quoteRawText("500 米", undefined)).toBe("500 米");
  });
});
