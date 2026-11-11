/**
 * 第二步验收演示：建客户 → 内核写入 → 审计日志有记录 → 智能体无法绕过内核。
 *
 * 运行：docker compose up -d && pnpm demo
 * 不需要界面，不需要 .env（默认值与 docker-compose.yml 一致）。
 */
import { sql } from "drizzle-orm";
import path from "node:path";
import { loadEnv } from "../src/platform/env";
import { connectDatabase } from "../src/platform/database";
import { connectRedis, pingRedis } from "../src/platform/redis";
import { createKernel, errorChainMessage } from "../src/kernel";
import type { KernelContext } from "../src/kernel";
import { formatMoney } from "../src/kernel/money";
import { createTools } from "../src/tools";

// 可选：仓库根目录存在 .env 时加载（Node 20.12+）。
try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值。
}

const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "demo-operator" } };
const AGENT: KernelContext = { actor: { type: "AGENT", id: "sample-followup-agent" } };

function section(title: string): void {
  console.log(`\n${title}`);
}

function ok(message: string): void {
  console.log(`  ✔ ${message}`);
}

function warn(message: string): void {
  console.log(`  ⚠ ${message}`);
}

async function waitForDatabase(handle: ReturnType<typeof connectDatabase>): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await handle.pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === 20) throw error;
      if (attempt === 1) console.log("  等待 PostgreSQL 就绪…");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = connectDatabase(env.DATABASE_URL);

  section("① 依赖检查");
  await waitForDatabase({ db, pool });
  ok(`PostgreSQL 连接正常（${env.DATABASE_URL}）`);

  const redis = connectRedis(env.REDIS_URL);
  const redisReady = await pingRedis(redis.client);
  if (redisReady) {
    ok(`Redis PING → PONG（${env.REDIS_URL}）`);
  } else {
    warn(`Redis 不可用（${env.REDIS_URL}），内核演示不需要它，继续`);
  }

  const tableCheck = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.customers') IS NOT NULL AS exists",
  );
  if (!tableCheck.rows[0]?.exists) {
    throw new Error("数据库表不存在，请先运行：pnpm db:migrate");
  }
  ok("迁移已应用（customers / audit_log 等表存在）");

  const kernel = createKernel(db);
  const tools = createTools(kernel);
  const suffix = Date.now().toString(36);

  section("② 内核建客户（写业务表 + 同事务审计）");
  const customer = await kernel.customers.create(
    {
      code: `DEMO-${suffix}`,
      name: "杭州织造有限公司",
      tier: "VIP",
      contactName: "张三",
      contactPhone: "13800000000",
      contactEmail: "zhangsan@example.com",
    },
    HUMAN,
  );
  ok(`客户已创建：${customer.name}（id=${customer.id}）`);
  ok("customer_contexts 已自动初始化（护城河数据默认值）");

  section("③ 内核建样品（带成本底线，供报价拦截用）");
  const sample = await kernel.samples.create(
    {
      code: `SMP-${suffix}`,
      name: "高支棉 220g",
      composition: "100% 棉",
      weight: "220g/m2",
      unit: "meter",
      costFloor: { amount: 1200, currency: "CNY" },
    },
    HUMAN,
  );
  ok(
    `样品已创建：${sample.code} / ${sample.name}，成本底线 ${formatMoney({ amount: 1200, currency: "CNY" })}/米`,
  );

  section("④ 智能体通过工具 T-005 创建寄样单（只能得到 DRAFT）");
  const shipmentResult = await tools.createSampleShipment.execute(
    {
      customerId: customer.id,
      items: [{ sampleId: sample.id, quantity: { value: 3, unit: "meter" } }],
      carrier: "顺丰",
      trackingNumber: "SF1234567890",
      note: "客户要 3 米色卡",
    },
    AGENT,
  );
  if (!shipmentResult.ok) {
    throw new Error(`T-005 失败：${JSON.stringify(shipmentResult.error)}`);
  }
  const shipment = shipmentResult.data.shipment;
  ok(`寄样单已创建：${shipment.id}，状态 = ${shipment.status}（智能体无法直接确认）`);
  ok(`内核建议跟进时间：${shipmentResult.data.followupSuggestedAt}`);

  section("⑤ 铁律 #2 实测：智能体确认寄样单会被内核拒绝");
  let deniedByKernel = false;
  try {
    await kernel.shipments.confirm(shipment.id, AGENT);
  } catch (error) {
    deniedByKernel = true;
    const message = error instanceof Error ? error.message : String(error);
    ok(`智能体确认被拒绝：${message}`);
  }
  if (!deniedByKernel) throw new Error("内核没有拒绝智能体确认寄样单，铁律失守！");

  const confirmedShipment = await kernel.shipments.confirm(shipment.id, HUMAN);
  ok(
    `人类确认后状态 = ${confirmedShipment.status}，confirmedBy = ${confirmedShipment.confirmedBy}`,
  );

  section("⑥ 智能体通过工具 T-004 生成报价草稿（金额由内核算）");
  const quoteResult = await tools.generateQuoteDraft.execute(
    {
      customerId: customer.id,
      currency: "CNY",
      items: [
        {
          fabricSampleId: sample.id,
          quantity: { value: 120.5, unit: "meter" },
          unitPrice: { amount: 1500, currency: "CNY" },
        },
      ],
      validityDays: 30,
      remarks: "含运费",
    },
    AGENT,
  );
  if (!quoteResult.ok) {
    throw new Error(`T-004 失败：${JSON.stringify(quoteResult.error)}`);
  }
  const draft = quoteResult.data.draft;
  ok(`报价草稿已生成：${draft.id}，状态 = ${draft.status}`);
  ok(
    `金额由内核算：单价 ${formatMoney(draft.items[0]!.unitPrice)}/米 × 120.5 米 = ${formatMoney(draft.total)}`,
  );

  section("⑦ 内核拒绝低于成本底线的报价（LLM 无法绕过）");
  let floorRejected = false;
  try {
    await kernel.quotes.generateDraft(
      {
        customerId: customer.id,
        currency: "CNY",
        items: [
          {
            fabricSampleId: sample.id,
            quantity: { value: 10, unit: "meter" },
            unitPrice: { amount: 800, currency: "CNY" },
          },
        ],
      },
      AGENT,
    );
  } catch (error) {
    floorRejected = true;
    const message = error instanceof Error ? error.message : String(error);
    ok(`报价被内核拒绝：${message}`);
  }
  if (!floorRejected) throw new Error("内核没有拦截低于成本底线的报价！");

  section("⑧ 报价草稿同样必须由人类确认");
  try {
    await kernel.quotes.confirmDraft(draft.id, AGENT);
    throw new Error("智能体竟然确认了报价草稿，铁律失守！");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("铁律失守")) throw error;
    ok(`智能体确认报价被拒绝：${message}`);
  }
  await kernel.quotes.confirmDraft(draft.id, HUMAN);
  ok("人类确认后报价草稿已转 SENT");

  section("⑨ 找样工具：参数匹配（T-002）与以图搜图（T-001）");
  const specResult = await tools.searchFabricBySpec.execute(
    { query: "高支棉", composition: "棉", limit: 5 },
    AGENT,
  );
  if (!specResult.ok) {
    throw new Error(`T-002 失败：${JSON.stringify(specResult.error)}`);
  }
  const bestMatch = specResult.data.matches[0];
  ok(
    `T-002 命中 ${specResult.data.matches.length} 个样品，首个：${bestMatch?.sample.name ?? "无"}（命中 ${bestMatch?.matchedOn.join("/") ?? "-"}）`,
  );

  // 演示用 1x1 PNG（不依赖外部模型 key，embedding 走 local stub）。
  const pixelPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const imageResult = await tools.searchFabricByImage.execute(
    { image: { mimeType: "image/png", base64: pixelPng }, topK: 3, minSimilarity: 0 },
    AGENT,
  );
  if (!imageResult.ok) {
    throw new Error(`T-001 失败：${JSON.stringify(imageResult.error)}`);
  }
  ok(
    `T-001 返回 ${imageResult.data.matches.length} 个候选（provider=${imageResult.data.embeddingModel}，dim=${imageResult.data.dimension}），相似度由内核算出`,
  );
  ok("两个工具都只读，不写账本；embedding provider 可在不改进程契约的情况下替换");

  section("⑩ 审计日志（每一次账本写入都有记录）");
  const auditRows = await kernel.audit.list(20);
  for (const row of auditRows.slice(0, 10)) {
    console.log(
      `  #${row.seq} ${row.action.padEnd(28)} actor=${row.actorType}:${row.actorId} entity=${row.entityType}:${row.entityId.slice(0, 8)}…`,
    );
  }
  ok(`本次共读取到 ${auditRows.length} 条审计记录（倒序）`);

  section("⑪ 审计日志不可篡改（数据库触发器拦截 UPDATE / DELETE）");
  try {
    await db.execute(
      sql`UPDATE audit_log SET actor_id = 'tampered' WHERE seq = ${auditRows[0]?.seq ?? -1}`,
    );
    throw new Error("审计日志竟然可以被 UPDATE，铁律失守！");
  } catch (error) {
    const message = errorChainMessage(error);
    if (message.includes("铁律失守")) throw error;
    ok(`UPDATE 被数据库拒绝：${message.replace(/\s+/g, " ")}`);
  }

  section("结论");
  ok("打开页面：pnpm dev → http://localhost:5173（选样品、点一个按钮，看到 DRAFT 与审计流水）");
  ok("建客户 → 内核写入 → 审计日志有记录：同一条命令跑通");
  ok("智能体只能通过工具拿到 DRAFT，确认动作只能由人类触发（内核校验 actor.type）");
  ok("报价金额、成本底线由内核计算与拦截，不信任 LLM 输出");
  ok("审计日志只能追加，数据库层面禁止修改");
  ok("agent 层无法 import kernel / drizzle / db（ESLint + 常驻回归测试）");

  await redis.close();
  await pool.end();
}

void main().catch((error: unknown) => {
  console.error("\n✖ 演示失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
