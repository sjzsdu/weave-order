import { describe, expect, it } from "vitest";
import { LocalRuleLlmProvider, createLlmProvider } from "../src/platform/llm";
import {
  LocalDeterministicLogisticsProvider,
  createLogisticsProvider,
} from "../src/platform/logistics";
import { LocalScriptedReplySource, createReplySource } from "../src/platform/reply-source";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const provider = new LocalRuleLlmProvider(() => NOW);

describe("本地确定性 LLM provider", () => {
  it("报价意图：quoteRequested=true", async () => {
    for (const text of ["报价多少钱？", "这个价格能低点吗", "please quote 100m"]) {
      const result = await provider.classifyReply({ text });
      expect(result.intent).toBe("PRICE_REQUEST");
      expect(result.quoteRequested).toBe(true);
      expect(result.provider).toBe("local-rule-v1");
    }
  });

  it("拒绝 / 反馈 / 确认 / 其它意图互不串线", async () => {
    expect((await provider.classifyReply({ text: "暂时不需要了" })).intent).toBe("NOT_INTERESTED");
    expect((await provider.classifyReply({ text: "手感很好，颜色也正" })).intent).toBe(
      "SAMPLE_FEEDBACK",
    );
    const ack = await provider.classifyReply({ text: "收到，谢谢" });
    expect(ack.intent).toBe("ACK");
    expect(ack.quoteRequested).toBe(false);
    expect((await provider.classifyReply({ text: "嗯" })).intent).toBe("OTHER");
  });

  it("跟进建议确定性复现，按物流状态组织话术", async () => {
    const shipment = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      tenantId: "00000000-0000-0000-0000-000000000001",
      customerId: "123e4567-e89b-12d3-a456-426614174001",
      status: "DRAFT" as const,
      channel: "COURIER" as const,
      carrier: "顺丰",
      trackingNumber: "SF1",
      note: null,
      items: [],
      confirmedBy: null,
      confirmedAt: null,
      createdAt: "2026-11-11T00:00:00.000Z",
    };
    const tracking = {
      carrier: "顺丰",
      trackingNumber: "SF1",
      status: "DELIVERED" as const,
      events: [
        {
          at: "2026-11-10T00:00:00.000Z",
          description: "已签收",
          location: "客户仓库",
        },
      ],
      provider: "local-deterministic-v1",
    };

    const first = await provider.suggestFollowup({
      customerId: shipment.customerId,
      shipment,
      tracking,
    });
    const second = await provider.suggestFollowup({
      customerId: shipment.customerId,
      shipment,
      tracking,
    });
    expect(first).toEqual(second);
    expect(first.suggestedAt).toBe("2026-11-13T00:00:00.000Z");
    expect(first.message).toContain("签收");
    expect(first.channel).toBe("WECHAT");
  });

  it("未知 provider 显式报错", () => {
    expect(createLlmProvider("local-rule").name).toBe("local-rule-v1");
    expect(() => createLlmProvider("openai")).toThrow(/不受支持/);
  });
});

describe("本地确定性物流 provider", () => {
  const logistics = new LocalDeterministicLogisticsProvider(() => NOW);

  it("同一运单号确定性复现，状态合法且事件有序", async () => {
    const first = await logistics.track({ carrier: "顺丰", trackingNumber: "SF123" });
    const second = await logistics.track({ carrier: "顺丰", trackingNumber: "SF123" });
    expect(first).toEqual(second);
    expect(["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]).toContain(first.status);
    expect(first.events.length).toBeGreaterThanOrEqual(2);
    expect(first.provider).toBe("local-deterministic-v1");
  });

  it("未知 provider 显式报错", () => {
    expect(createLogisticsProvider("local-deterministic").name).toBe("local-deterministic-v1");
    expect(() => createLogisticsProvider("kuaidi100")).toThrow(/尚未接入/);
  });
});

describe("客户回复来源", () => {
  it("脚本化来源按顺序消费，用完后返回 null", async () => {
    const source = new LocalScriptedReplySource([
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        channel: "WECHAT",
        text: "报价多少钱",
        receivedAt: NOW.toISOString(),
      },
    ]);
    const reply = await source.fetchLatest({
      customerId: "c",
      shipmentId: "s",
    });
    expect(reply?.text).toBe("报价多少钱");
    expect(await source.fetchLatest({ customerId: "c", shipmentId: "s" })).toBeNull();
  });

  it("未知渠道来源显式报错", () => {
    expect(createReplySource("local-scripted").name).toBe("local-scripted-v1");
    expect(() => createReplySource("wechat-real")).toThrow(/尚未接入/);
  });
});
