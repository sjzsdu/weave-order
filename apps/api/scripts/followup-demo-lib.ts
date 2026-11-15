/**
 * 第四步 demo 的共享装配：数据库、内核、工具、providers、图。
 * 父子进程各自调用一次，确保「重启后续跑」是真的新进程 + 新连接。
 */
import path from "node:path";
import { createPostgresCheckpointer } from "../src/platform/checkpoint";
import { connectDatabase } from "../src/platform/database";
import type { DatabaseHandle } from "../src/platform/database";
import { loadEnv } from "../src/platform/env";
import type { Env } from "../src/platform/env";
import { createLlmProvider } from "../src/platform/llm";
import { createLogisticsProvider } from "../src/platform/logistics";
import { createReplySource } from "../src/platform/reply-source";
import { createKernel } from "../src/kernel";
import { createTools } from "../src/tools";
import { createFollowupGraph } from "../src/agent";
import type { FollowupGraph } from "../src/agent";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值
}

export interface DemoContext {
  env: Env;
  handle: DatabaseHandle;
  graph: FollowupGraph;
  kernel: ReturnType<typeof createKernel>;
}

export async function waitForDatabase(handle: DatabaseHandle): Promise<void> {
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

export async function createDemoContext(): Promise<DemoContext> {
  const env = loadEnv();
  if (env.LLM_PROVIDER !== "litellm") {
    console.log(
      "\n⚠ 【模拟轨迹】LLM_PROVIDER=local-rule：下文跟进建议与意图识别均为本地规则产出，" +
        "不是真实模型调用，不得当作真实现场数据。",
    );
  }
  if (env.LOGISTICS_PROVIDER !== "real") {
    console.log("⚠ 【模拟轨迹】LOGISTICS_PROVIDER 为本地确定性实现：物流状态是模拟数据。");
  }
  const handle = connectDatabase(env.DATABASE_URL);
  await waitForDatabase(handle);

  const tableCheck = await handle.pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.sample_shipments') IS NOT NULL AS exists",
  );
  if (!tableCheck.rows[0]?.exists) {
    await handle.pool.end();
    throw new Error("数据库表不存在，请先运行：pnpm db:migrate");
  }

  const kernel = createKernel(handle.db);
  const tools = createTools(kernel);
  const checkpointer = await createPostgresCheckpointer(handle.pool);
  const graph = createFollowupGraph({
    tools,
    llm: createLlmProvider(env.LLM_PROVIDER),
    logistics: createLogisticsProvider(env.LOGISTICS_PROVIDER),
    replySource: createReplySource(env.REPLY_SOURCE, {
      // REPLY_SOURCE=manual 时，图从 inbound_messages 取一条未消费的回复，
      // 并原子标记 consumed（一条回复只驱动一次）。
      fetchManualReply: async ({ customerId, shipmentId }) => {
        const message = await kernel.inboundReplies.claimLatest({ customerId, shipmentId });
        return message
          ? { id: message.id, text: message.text, receivedAt: message.receivedAt }
          : null;
      },
    }),
    checkpointer,
  });

  return { env, handle, graph, kernel };
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

export function ok(message: string): void {
  console.log(`  ✔ ${message}`);
}

export function warn(message: string): void {
  console.log(`  ⚠ ${message}`);
}
