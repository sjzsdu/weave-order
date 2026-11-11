import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { createFollowupGraph } from "../src/agent";
import type { FollowupStateType } from "../src/agent";
import { LocalRuleLlmProvider } from "../src/platform/llm";
import { LocalDeterministicLogisticsProvider } from "../src/platform/logistics";
import { LocalScriptedReplySource } from "../src/platform/reply-source";
import type { Tools } from "../src/tools";

/** 工具失败的离线单测：不需要数据库，检查节点把失败收敛到 FAILED 而不是抛出。 */
const failingTools = {
  createSampleShipment: {
    execute: () =>
      Promise.resolve({
        ok: false,
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "样品不存在：missing",
          resourceType: "sample",
          resourceId: "missing",
        },
      }),
  },
} as unknown as Tools;

const baseInput = {
  threadId: "unit-failure",
  customerId: "123e4567-e89b-12d3-a456-426614174000",
  sampleId: "123e4567-e89b-12d3-a456-426614174001",
  quantityValue: 3,
  quantityUnit: "meter" as const,
  carrier: "顺丰",
  trackingNumber: "SFUNIT",
  unitPriceAmount: 1500,
  currency: "CNY" as const,
};

describe("寄样跟进图（工具失败分支，MemorySaver）", () => {
  it("T-005 返回失败时进入 FAILED，不产出后续状态", async () => {
    const graph = createFollowupGraph({
      tools: failingTools,
      llm: new LocalRuleLlmProvider(),
      logistics: new LocalDeterministicLogisticsProvider(),
      replySource: new LocalScriptedReplySource(),
      checkpointer: new MemorySaver(),
    });

    const result = await graph.invoke(baseInput, {
      configurable: { thread_id: "unit-failure" },
    });
    expect(result.stage).toBe("FAILED");
    expect(result.failure?.node).toBe("createShipment");
    expect(result.failure?.code).toBe("RESOURCE_NOT_FOUND");
    expect(result.failure?.stage).toBe("NEW");
    expect(result.shipment).toBeNull();
    expect(result.quote).toBeNull();
    expect(result.steps.some((step) => step.includes("RESOURCE_NOT_FOUND"))).toBe(true);
  });

  it("失败后检查点停在 FAILED，重跑仍不会伪造成功", async () => {
    const graph = createFollowupGraph({
      tools: failingTools,
      llm: new LocalRuleLlmProvider(),
      logistics: new LocalDeterministicLogisticsProvider(),
      replySource: new LocalScriptedReplySource(),
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "unit-failure-2" } };
    await graph.invoke(baseInput, config);
    const snapshot = await graph.getState(config);
    expect((snapshot.values as FollowupStateType).stage).toBe("FAILED");
    expect(snapshot.next).toEqual([]);
  });
});
