/**
 * 第四步验收（进程 A）：开一条寄样跟进智能体线程，跑到「等客户回复」中断。
 * 中断后关闭数据库连接、退出进程；进程 B 会从 PostgreSQL 检查点继续。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createDemoContext, ok, section } from "./followup-demo-lib";
import { demoWriteContext, ensureDemoIdentity } from "./demo-identity";
import type { FollowupStateType } from "../src/agent";

async function main(): Promise<void> {
  const { handle, graph, kernel } = await createDemoContext();
  const identity = await ensureDemoIdentity(handle.db);
  const HUMAN_OPERATOR = demoWriteContext(identity, "demo-operator");
  const suffix = Date.now().toString(36);

  section("① 准备演示客户与样品（内核写入，带审计）");
  const customer = await kernel.customers.create(
    { code: `FLW-C-${suffix}`, name: "苏州纺织（寄样跟进演示）", tier: "VIP" },
    HUMAN_OPERATOR,
  );
  const sample = await kernel.samples.create(
    {
      code: `FLW-S-${suffix}`,
      name: "寄样跟进演示面料",
      composition: "100% 棉",
      weight: "220g/m2",
      unit: "meter",
      costFloor: { amount: 1200, currency: "CNY" },
    },
    HUMAN_OPERATOR,
  );
  ok(`客户 ${customer.code} / 样品 ${sample.code}`);

  const threadId = `followup-demo-${suffix}`;
  const config = { configurable: { thread_id: threadId } };
  const trackingNumber = `SF${suffix.toUpperCase()}`;

  section("② 运行智能体（进程 A）：建寄样单 → 追踪物流 → 生成跟进建议 → 等待回复");
  const first = await graph.invoke(
    {
      threadId,
      customerId: customer.id,
      sampleId: sample.id,
      quantityValue: 3,
      quantityUnit: "meter",
      carrier: "顺丰",
      trackingNumber,
      unitPriceAmount: 1500,
      currency: "CNY",
    },
    config,
  );

  const snapshot = await graph.getState(config);
  const checkpointId = (snapshot.config as { configurable?: { checkpoint_id?: string } })
    .configurable?.checkpoint_id;

  ok(
    `寄样单 ${first.shipment?.id ?? "-"} 状态 ${first.shipment?.status ?? "-"}（T-005 只产出 DRAFT）`,
  );
  ok(
    `物流 ${first.tracking?.status ?? "-"}（${first.tracking?.provider ?? "-"}，${first.tracking?.events.length ?? 0} 条轨迹）`,
  );
  ok(
    `跟进建议计划发送时间 ${first.followup?.suggestedAt ?? "-"}（${first.followup?.provider ?? "-"}）`,
  );
  ok(`智能体停在阶段 ${first.stage}，等待客户回复`);

  section("③ 中断点（已持久化到 PostgreSQL）");
  ok(`thread = ${threadId}`);
  ok(`checkpoint = ${checkpointId ?? "未知"}`);
  ok(
    `下一个节点 = ${snapshot.next.join(", ") || "无"}；state.stage = ${String((snapshot.values as FollowupStateType).stage)}`,
  );

  const interrupted: { value: unknown }[] =
    (first as typeof first & { __interrupt__?: { value: unknown }[] }).__interrupt__ ?? [];
  if (interrupted.length === 0) {
    throw new Error("图没有在 awaitReply 中断，检查点续跑演示不成立");
  }
  ok(`interrupt payload = ${JSON.stringify(interrupted[0]?.value)}`);

  const audit = await kernel.audit.list(20);
  const shipmentAudit = audit.filter((row) => row.entityId === first.shipment?.id);
  for (const row of shipmentAudit) {
    console.log(`  #${row.seq} ${row.action} actor=${row.actorType}:${row.actorId}`);
  }
  ok(`本次寄样单相关审计 ${shipmentAudit.length} 条`);

  section("④ 模拟进程中断：关闭进程 A 的数据库连接（A 的图对象不再参与后续）");
  await handle.pool.end();
  ok("进程 A 的数据库连接已关闭；状态只存在于 PostgreSQL 检查点");

  section("⑤ 启动全新进程 B（独立 Node 进程 + 独立连接池）从检查点恢复");
  const replyText = "样品收到了，手感不错。这款报价多少钱？";
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(__dirname, "demo-followup-resume.ts"), threadId, replyText],
    {
      cwd: path.join(__dirname, ".."),
      env: process.env,
      encoding: "utf8",
    },
  );
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  if (child.status !== 0) {
    throw new Error(`进程 B 失败，退出码 ${String(child.status)}`);
  }

  section("⑥ 结论");
  ok("检查点真的存了：进程 B 用新进程/新连接从同一 thread 继续，未共享内存状态");
  ok("智能体只通过 tools 动作，客户回复触发的报价停在 DRAFT");
  ok("物流 / LLM / 回复来源都是可替换 provider，本轮默认本地确定性实现、零外部 key");
}

void main().catch((error: unknown) => {
  console.error("\n✖ 寄样跟进 demo 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
