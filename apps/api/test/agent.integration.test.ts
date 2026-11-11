import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import { RawCustomerReply } from "@weave-order/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@weave-order/db";
import type { DatabaseHandle } from "../src/platform/database";
import { createPostgresCheckpointer } from "../src/platform/checkpoint";
import { LocalRuleLlmProvider } from "../src/platform/llm";
import { LocalDeterministicLogisticsProvider } from "../src/platform/logistics";
import { LocalScriptedReplySource } from "../src/platform/reply-source";
import { createKernel } from "../src/kernel";
import type { Kernel } from "../src/kernel";
import { createTools } from "../src/tools";
import { createFollowupGraph } from "../src/agent";
import type { FollowupGraph, FollowupStateType } from "../src/agent";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

/**
 * 寄样跟进智能体集成测试：真实 PostgreSQL + LangGraph PostgresSaver。
 * 没有数据库时跳过；检查点表由 saver.setup() 创建。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const HUMAN = { actor: { type: "HUMAN" as const, id: "agent-it" } };

let handle: DatabaseHandle | null = null;
let saver: PostgresSaver | null = null;
let kernel: Kernel | null = null;
let available = false;

beforeAll(async () => {
  try {
    handle = createDb(DATABASE_URL);
    await handle.pool.query("SELECT 1");
    saver = await createPostgresCheckpointer(handle.pool);
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

interface Seeded {
  customerId: string;
  sampleId: string;
}

async function seed(costFloorAmount = 1200): Promise<Seeded> {
  if (!kernel) throw new Error("数据库不可用");
  const id = suffix();
  const customer = await kernel.customers.create(
    { code: `AG-C-${id}`, name: "智能体测试客户" },
    HUMAN,
  );
  const sample = await kernel.samples.create(
    {
      code: `AG-S-${id}`,
      name: "智能体测试面料",
      unit: "meter",
      costFloor: { amount: costFloorAmount, currency: "CNY" },
    },
    HUMAN,
  );
  return { customerId: customer.id, sampleId: sample.id };
}

function buildGraph(): FollowupGraph {
  if (!kernel || !saver) throw new Error("数据库不可用");
  return createFollowupGraph({
    tools: createTools(kernel),
    llm: new LocalRuleLlmProvider(),
    logistics: new LocalDeterministicLogisticsProvider(),
    replySource: new LocalScriptedReplySource(),
    checkpointer: saver,
  });
}

function inputFor(seeded: Seeded, unitPriceAmount = 1500) {
  const id = suffix();
  return {
    threadId: `agent-it-${id}`,
    customerId: seeded.customerId,
    sampleId: seeded.sampleId,
    quantityValue: 3,
    quantityUnit: "meter" as const,
    carrier: "顺丰",
    trackingNumber: `SFIT${id}`,
    unitPriceAmount,
    currency: "CNY" as const,
  };
}

const replyWith = (text: string) =>
  RawCustomerReply.parse({
    id: randomUUID(),
    channel: "WECHAT",
    text,
    receivedAt: new Date().toISOString(),
  });

describe("寄样跟进智能体（集成）", () => {
  it("跑到等待回复中断；新图实例从检查点恢复并产出 DRAFT 报价", async (ctx) => {
    if (!available || !kernel || !saver) {
      ctx.skip();
      return;
    }
    const seeded = await seed();
    const input = inputFor(seeded);
    const config = { configurable: { thread_id: input.threadId } };
    const graphA = buildGraph();

    const first = await graphA.invoke(input, config);
    const interrupts = (first as typeof first & { __interrupt__?: unknown[] }).__interrupt__;
    expect(Array.isArray(interrupts)).toBe(true);
    expect(first.stage).toBe("WAITING_REPLY");
    expect(first.shipment?.status).toBe("DRAFT");
    expect(first.tracking?.events.length).toBeGreaterThan(0);
    expect(first.followup).not.toBeNull();
    expect(first.quote).toBeNull();

    const paused = await graphA.getState(config);
    expect(paused.next).toContain("awaitReply");
    const pausedValues = paused.values as FollowupStateType;
    expect(pausedValues.stage).toBe("WAITING_REPLY");

    const audit = await kernel.audit.list(100);
    expect(
      audit.some(
        (row) =>
          row.entityId === first.shipment?.id &&
          row.action === "SAMPLE_SHIPMENT_DRAFTED" &&
          row.actorType === "AGENT",
      ),
    ).toBe(true);

    // 模拟重启：新图实例 + 同一个 PostgreSQL 检查点
    const graphB = buildGraph();
    const resumed = await graphB.invoke(
      new Command({ resume: replyWith("这款报价多少钱？") }),
      config,
    );
    expect(resumed.stage).toBe("DONE");
    expect(resumed.classification?.intent).toBe("PRICE_REQUEST");
    expect(resumed.quote?.status).toBe("DRAFT");
    expect(resumed.quote?.amountsComputedByKernel).toBe(true);
    expect(resumed.quote?.total.amount).toBe(4500);

    const auditAfter = await kernel.audit.list(100);
    expect(
      auditAfter.some(
        (row) =>
          row.entityId === resumed.quote?.id &&
          row.action === "QUOTE_DRAFT_GENERATED" &&
          row.actorType === "AGENT",
      ),
    ).toBe(true);

    await saver.deleteThread(input.threadId);
  }, 30_000);

  it("客户没有问价：流程 DONE，不产出报价草稿", async (ctx) => {
    if (!available || !kernel || !saver) {
      ctx.skip();
      return;
    }
    const input = inputFor(await seed());
    const config = { configurable: { thread_id: input.threadId } };
    const graph = buildGraph();

    await graph.invoke(input, config);
    const resumed = await graph.invoke(new Command({ resume: replyWith("收到，谢谢") }), config);
    expect(resumed.stage).toBe("DONE");
    expect(resumed.classification?.intent).toBe("ACK");
    expect(resumed.quote).toBeNull();

    await saver.deleteThread(input.threadId);
  }, 30_000);

  it("工具失败（样品不存在）：FAILED，不伪造成功", async (ctx) => {
    if (!available || !kernel || !saver) {
      ctx.skip();
      return;
    }
    const seeded = await seed();
    const input = { ...inputFor(seeded), sampleId: randomUUID() };
    const graph = buildGraph();

    const result = await graph.invoke(input, {
      configurable: { thread_id: input.threadId },
    });
    expect(result.stage).toBe("FAILED");
    expect(result.failure?.node).toBe("createShipment");
    expect(result.failure?.code).toBe("RESOURCE_NOT_FOUND");
    expect(result.quote).toBeNull();

    await saver.deleteThread(input.threadId);
  }, 30_000);

  it("报价工具失败（低于成本底线）：FAILED，报价为空", async (ctx) => {
    if (!available || !kernel || !saver) {
      ctx.skip();
      return;
    }
    const seeded = await seed(1200);
    const input = inputFor(seeded, 800);
    const config = { configurable: { thread_id: input.threadId } };
    const graph = buildGraph();

    await graph.invoke(input, config);
    const resumed = await graph.invoke(new Command({ resume: replyWith("请报价") }), config);
    expect(resumed.stage).toBe("FAILED");
    expect(resumed.failure?.node).toBe("generateQuoteDraft");
    expect(resumed.failure?.code).toBe("KERNEL_REJECTED");
    expect(resumed.quote).toBeNull();

    await saver.deleteThread(input.threadId);
  }, 30_000);
});
