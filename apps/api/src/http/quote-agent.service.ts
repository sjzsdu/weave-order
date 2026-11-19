import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { QuoteAgentResult, QuoteRequestInput } from "@weave-order/schema";
import type { QuoteAgentResult as Result } from "@weave-order/schema";
import { createQuoteAgentGraph, QUOTING_AGENT_CONTEXT, toQuoteAgentResult } from "../agent";
import { scopeWindowOf } from "../kernel";
import type { Kernel, KernelContext } from "../kernel";
import { getPostgresCheckpointer } from "../platform/checkpoint";
import { DatabaseProvider } from "../platform/database.provider";
import { loadEnv } from "../platform/env";
import {
  EXECUTION_FAILURE_CODE,
  EXECUTION_FAILURE_NODE,
  EXECUTION_FAILURE_REASON,
} from "../platform/execution-error";
import { createResilientLlmProvider } from "../platform/llm";
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
  private readonly logger = new Logger(QuoteAgentService.name);

  constructor(
    @Inject(KERNEL) private readonly fallbackKernel: Kernel,
    @Inject(HumanActorService) private readonly human: HumanActorService,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  async run(authorization: string | undefined, body: unknown) {
    return this.human.run(authorization, this.fallbackKernel, async (kernel, humanCtx) => {
      const input = QuoteRequestInput.parse(body);
      const threadId = input.threadId ?? randomUUID();
      try {
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
      } catch (error) {
        // 组合根 / 检查点 / 数据库异常时模型根本没被调用，不能谎报成模型不可用。
        // 原始错误只进日志；对外仍是可重试的三态结果（WAN-180）。
        this.logger.error(
          `报价 agent 执行失败 threadId=${threadId}`,
          error instanceof Error ? error.stack : String(error),
        );
        return infrastructureFailure(threadId);
      }
    });
  }

  private async buildGraph(kernel: Kernel, driver: KernelContext) {
    const env = loadEnv();
    const settings = await kernel.llmSettings.resolve();
    const provider =
      env.LLM_PROVIDER === "openai-compatible" && settings.allowExternal
        ? "openai-compatible"
        : "local-rule";
    // 网关 403 / 超时 / 配置缺失都回退 local-rule：WAN-172 的底线是「模型坏了，报价还能出」。
    const llm = createResilientLlmProvider(provider, { settings, usage: kernel.usage, env });
    // 冷启动并发请求共享同一次 checkpointer 初始化，见 platform/checkpoint.ts。
    const checkpointer = await getPostgresCheckpointer(this.database.handle.pool);
    return createQuoteAgentGraph({
      tools: createTools(kernel),
      llm,
      checkpointer,
      // 草稿仍以 AGENT 身份落审计，但数据范围跟驱动者走：
      // 不带范围的话，OWN 成员可以借本路由生成/读取他人名下客户。
      ctx: { ...QUOTING_AGENT_CONTEXT, ...(scopeWindowOf(driver) ?? {}) },
    });
  }
}

/** 基础设施异常时的对外结果：FAILED 但原因诚实、可重试，不把内部错误抛成 500。 */
export function infrastructureFailure(threadId: string): Result {
  return QuoteAgentResult.parse({
    threadId,
    stage: "FAILED",
    status: "FAILED",
    intent: null,
    candidates: [],
    selectedSampleId: null,
    pricingBasis: null,
    draft: null,
    missingFields: [],
    explanation: EXECUTION_FAILURE_REASON,
    notice: null,
    provider: "local-rule-v1",
    usage: null,
    failure: {
      node: EXECUTION_FAILURE_NODE,
      code: EXECUTION_FAILURE_CODE,
      message: EXECUTION_FAILURE_REASON,
      stage: "NEW",
    },
  });
}
