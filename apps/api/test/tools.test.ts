import { describe, expect, it } from "vitest";
import type { Kernel } from "../src/kernel";
import { createGenerateQuoteDraftTool } from "../src/tools/generate-quote-draft.tool";
import { createGetCustomerHistoryTool } from "../src/tools/get-customer-history.tool";
import type { KernelContext } from "../src/kernel";

const AGENT: KernelContext = { actor: { type: "AGENT", id: "test-agent" } };

/** 这些用例只走输入校验分支，不应触达内核；用空内核即可。 */
const unusedKernel = {} as Kernel;

describe("工具层：输入校验与失败语义封闭", () => {
  it("T-003 非 UUID 输入 -> INVALID_INPUT（不是 INTERNAL）", async () => {
    const tool = createGetCustomerHistoryTool(unusedKernel);
    const result = await tool.execute({ customerId: "not-a-uuid" }, AGENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("T-003 未知字段被拒绝（.strict()，智能体不能夹带账本字段）", async () => {
    const tool = createGetCustomerHistoryTool(unusedKernel);
    const result = await tool.execute(
      {
        customerId: "123e4567-e89b-12d3-a456-426614174000",
        decisionDeltas: [],
      },
      AGENT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("T-004 浮点金额 -> INVALID_INPUT（金额必须是整数分）", async () => {
    const tool = createGenerateQuoteDraftTool(unusedKernel);
    const result = await tool.execute(
      {
        customerId: "123e4567-e89b-12d3-a456-426614174000",
        currency: "CNY",
        items: [
          {
            fabricSampleId: "123e4567-e89b-12d3-a456-426614174001",
            quantity: { value: 10, unit: "meter" },
            unitPrice: { amount: 10.5, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      if (result.error.code === "INVALID_INPUT") {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    }
  });
});
