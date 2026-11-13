import path from "node:path";
import { createPostgresCheckpointer } from "../src/platform/checkpoint";
import { connectDatabase } from "../src/platform/database";
import type { DatabaseHandle } from "../src/platform/database";
import { loadEnv } from "../src/platform/env";
import type { Env } from "../src/platform/env";
import { createLlmProvider } from "../src/platform/llm";
import type { LlmProvider } from "../src/platform/llm";
import { createKernel } from "../src/kernel";
import type { Kernel } from "../src/kernel";
import { createTools } from "../src/tools";
import { createQuoteAgentGraph } from "../src/agent";
import type { QuoteAgentGraph } from "../src/agent";

try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // 没有 .env 就用默认值
}

export interface QuoteDemoContext {
  env: Env;
  handle: DatabaseHandle;
  kernel: Kernel;
  graph: QuoteAgentGraph;
  llm: LlmProvider;
}

async function waitForDatabase(handle: DatabaseHandle): Promise<void> {
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

/**
 * 报价 agent 的装配：内核 → 工具 → LLM（LiteLLM / 本地规则）→ 图。
 * 默认 local-rule 便于零 key 演示；LLM_PROVIDER=litellm 时走 LiteLLM 并记账。
 */
export async function createQuoteDemoContext(): Promise<QuoteDemoContext> {
  const env = loadEnv();
  const handle = connectDatabase(env.DATABASE_URL);
  await waitForDatabase(handle);

  const kernel = createKernel(handle.db);
  const settings = await kernel.llmSettings.resolve();
  const provider =
    env.LLM_PROVIDER === "litellm" && settings.allowExternal ? "litellm" : "local-rule";
  const llm = createLlmProvider(provider, { settings, usage: kernel.usage, env });
  const checkpointer = await createPostgresCheckpointer(handle.pool);
  const graph = createQuoteAgentGraph({
    tools: createTools(kernel),
    llm,
    checkpointer,
  });

  return { env, handle, kernel, graph, llm };
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

export function ok(message: string): void {
  console.log(`  ✔ ${message}`);
}
