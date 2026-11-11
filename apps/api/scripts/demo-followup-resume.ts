/**
 * 第四步验收（进程 B）：从 PostgreSQL 检查点恢复同一条线程，
 * 注入客户回复并继续跑完（识别回复 → 触发报价草稿）。
 */
import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import { RawCustomerReply } from "@weave-order/schema";
import { createDemoContext, ok, section } from "./followup-demo-lib";
import type { FollowupStateType } from "../src/agent";

async function main(): Promise<void> {
  const threadId = process.argv[2];
  const replyText = process.argv[3];
  if (!threadId || !replyText) {
    throw new Error("用法：demo-followup-resume.ts <threadId> <replyText>");
  }

  const { handle, graph, kernel } = await createDemoContext();
  const config = { configurable: { thread_id: threadId } };

  section("⑤ 进程 B：读取检查点");
  const before = await graph.getState(config);
  const checkpointId = (before.config as { configurable?: { checkpoint_id?: string } }).configurable
    ?.checkpoint_id;
  if (before.next.length === 0) {
    throw new Error(`线程 ${threadId} 没有待恢复节点（next 为空）`);
  }
  const beforeValues = before.values as FollowupStateType;
  ok(`恢复点 checkpoint = ${checkpointId ?? "未知"}`);
  ok(`待执行节点 = ${before.next.join(", ")}；恢复前 stage = ${String(beforeValues.stage)}`);
  ok(`寄样单 ${beforeValues.shipment?.id ?? "-"}（${beforeValues.shipment?.status ?? "-"}）`);
  ok(`跟进建议仍在建议态：${beforeValues.followup?.message.slice(0, 24) ?? "-"}…`);

  const reply = RawCustomerReply.parse({
    id: randomUUID(),
    channel: "WECHAT",
    text: replyText,
    receivedAt: new Date().toISOString(),
  });

  section("⑥ 进程 B：注入客户回复并继续执行");
  const resumed = await graph.invoke(new Command({ resume: reply }), config);

  ok(
    `客户回复识别：${resumed.classification?.intent ?? "-"}（confidence=${resumed.classification?.confidence ?? "-"}）`,
  );
  ok(`quoteRequested = ${String(resumed.classification?.quoteRequested ?? false)}`);
  const quote = resumed.quote;
  if (!quote) {
    throw new Error("客户询价却没有产出报价草稿，流程不完整");
  }
  ok(
    `报价草稿 ${quote.id}：状态 ${quote.status}，total = ${quote.total.amount} 分（${quote.currency}）`,
  );
  ok(`amountsComputedByKernel = ${String(quote.amountsComputedByKernel)}`);
  ok(`最终 stage = ${resumed.stage}，steps = ${resumed.steps.length} 步`);

  for (const step of resumed.steps) {
    console.log(`    · ${step}`);
  }

  section("⑦ 审计流水（进程 B 读取 PostgreSQL）");
  const audit = await kernel.audit.list(50);
  const relevant = audit.filter(
    (row) => row.entityId === quote.id || row.entityId === resumed.shipment?.id,
  );
  for (const row of relevant) {
    console.log(
      `  #${row.seq} ${row.action} actor=${row.actorType}:${row.actorId} entity=${row.entityType}`,
    );
  }
  ok(`本次线程相关审计 ${relevant.length} 条（寄样单 + 报价）`);

  await handle.pool.end();
}

void main().catch((error: unknown) => {
  console.error("\n✖ 恢复执行失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
