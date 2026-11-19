import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { QuoteRequestInput } from "@weave-order/schema";
import { createQuoteAgentGraph, QUOTING_AGENT_CONTEXT, toQuoteAgentResult } from "../agent";
import { scopeWindowOf } from "../kernel";
import type { Kernel, KernelContext } from "../kernel";
import { createPostgresCheckpointer } from "../platform/checkpoint";
import { DatabaseProvider } from "../platform/database.provider";
import { loadEnv } from "../platform/env";
import { createLlmProvider } from "../platform/llm";
import { createTools } from "../tools";
import { HumanActorService } from "./human-actor.service";
import { KERNEL } from "./tokens";

/**
 * 报价 agent 的 HTTP 组合根。
 *
 * - 租户内核由 `HumanActorService` 按登录态打开（RLS 会话），agent 仍只拿 tools。
 * - 检查点用平台连接（LangGraph 内部表，不走业务 RLS），thread 每次请求独立。
 */
@Injectable()
export class QuoteAgentService {
  private checkpointer: BaseCheckpointSaver | null = null;

  constructor(
    @Inject(KERNEL) private readonly fallbackKernel: Kernel,
    @Inject(HumanActorService) private readonly human: HumanActorService,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  async run(authorization: string | undefined, body: unknown) {
    return this.human.run(authorization, this.fallbackKernel, async (kernel, humanCtx) => {
      const input = QuoteRequestInput.parse(body);
      const threadId = input.threadId ?? randomUUID();
      const graph = await this.buildGraph(kernel, humanCtx);
      const state = await graph.invoke(
        {
          threadId,
          rawText: input.rawText,
          customerId: input.customerId ?? null,
          currency: input.currency,
          image: input.image ?? null,
          imageUrl: input.imageUrl ?? null,
          topK: input.topK,
        },
        { configurable: { thread_id: threadId } },
      );
      return toQuoteAgentResult(state);
    });
  }

  private async buildGraph(kernel: Kernel, driver: KernelContext) {
    const env = loadEnv();
    const settings = await kernel.llmSettings.resolve();
    const provider =
      env.LLM_PROVIDER === "openai-compatible" && settings.allowExternal
        ? "openai-compatible"
        : "local-rule";
    const llm = createLlmProvider(provider, { settings, usage: kernel.usage, env });
    this.checkpointer ??= await createPostgresCheckpointer(this.database.handle.pool);
    return createQuoteAgentGraph({
      tools: createTools(kernel),
      llm,
      checkpointer: this.checkpointer,
      // 草稿仍以 AGENT 身份落审计，但数据范围跟驱动者走：
      // 不带范围的话，OWN 成员可以借本路由生成/读取他人名下客户。
      ctx: { ...QUOTING_AGENT_CONTEXT, ...(scopeWindowOf(driver) ?? {}) },
    });
  }
}
