import { Inject, Injectable } from "@nestjs/common";
import type { IntentDraft, JsonValue, QuoteAgentResult } from "@weave-order/schema";
import type { Kernel } from "../kernel";
import { humanizeLlmError } from "../platform/llm";
import { HumanActorService } from "./human-actor.service";
import type { QuoteAgentService } from "./quote-agent.service";
import { HUMAN_ACTOR, KERNEL, QUOTE_AGENT } from "./tokens";

/**
 * 意图执行器：把「说点什么」接进真实的报价 agent。
 *
 * 设计要点：
 * - 提交路径只负责 markRunning + 启动，不等模型；状态由意图表承载，前端照常轮询。
 * - 执行器的所有结局都必须落库（SUCCEEDED / NEEDS_INPUT / FAILED），
 *   连同「执行器自身抛错」也在 `start` 的兜底里落 FAILED，绝不让意图卡在 RUNNING。
 * - 用户已撤销或已超时时状态迁移会抛错：这是预期，不覆盖用户可见的终态。
 */

export interface IntentExecutionInput {
  intentId: string;
  text: string;
  context?: JsonValue;
}

export type IntentOutcome =
  | { status: "SUCCEEDED"; draft: IntentDraft }
  | { status: "NEEDS_INPUT"; reason: string }
  | { status: "FAILED"; reason: string };

const MAX_REASON = 500;

function clamp(reason: string): string {
  const trimmed = reason.trim();
  return (trimmed.length > 0 ? trimmed : "小织这次没整理出来，原话还在，可以重试。").slice(
    0,
    MAX_REASON,
  );
}

function asRecord(value: JsonValue | undefined): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function customerIdOf(context: JsonValue | undefined): string | undefined {
  const value = asRecord(context).customerId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 开张清单带过来的样品编号拼进原话：报价 agent 只按文本找样，
 * 带上编号才能命中用户已经选中的那个样品（不新增工具 / 不猜样品）。
 */
export function quoteRawText(text: string, context: JsonValue | undefined): string {
  const sampleCode = asRecord(context).sampleCode;
  if (typeof sampleCode !== "string" || sampleCode.trim().length === 0) return text;
  return `${text}（样品编号 ${sampleCode.trim()}）`;
}

/** 报价 agent 的失败信息可能来自工具，也可能是网关原文；后者必须收成人话。 */
function failureReasonOf(result: QuoteAgentResult): string {
  const message = result.failure?.message ?? result.explanation;
  if (!result.failure) return clamp(message);
  if (/HTTP \d{3}|request id|企业模型网关/i.test(message)) {
    return clamp(humanizeLlmError(new Error(message)));
  }
  return clamp(message);
}

/**
 * 纯映射：QuoteAgent 的三态 → 意图的三态。
 * 单独导出是为了让状态映射能被单测覆盖，不需要真实模型与数据库。
 */
export function intentOutcomeFromQuoteResult(result: QuoteAgentResult): IntentOutcome {
  if (result.status === "DRAFTED" && result.draft) {
    return {
      status: "SUCCEEDED",
      draft: {
        kind: "quote",
        id: result.draft.id,
        title: `报价草稿 ${result.draft.id.slice(0, 8)}`,
      },
    };
  }

  if (result.status === "NEEDS_INPUT") {
    const blocking = result.missingFields.filter((field) => field.blocking);
    const prompts = result.missingFields.filter((field) => !field.blocking);
    const missing = blocking.map((field) => `${field.label}（${field.prompt}）`).join("；");
    const optional = prompts.map((field) => field.label).join("、");
    const reason = [
      missing ? `还差：${missing}。` : "还差一些信息才能出报价草稿。",
      optional ? `建议补充：${optional}。` : "",
      result.notice ?? "",
      "原话已保留，补齐后重试即可。",
    ]
      .filter(Boolean)
      .join(" ");
    return { status: "NEEDS_INPUT", reason: clamp(reason) };
  }

  return { status: "FAILED", reason: failureReasonOf(result) };
}

@Injectable()
export class IntentExecutorService {
  constructor(
    @Inject(QUOTE_AGENT) private readonly quoteAgent: QuoteAgentService,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(KERNEL) private readonly fallbackKernel: Kernel,
  ) {}

  /** 不阻塞 HTTP 响应；所有异常都在内部落 FAILED。 */
  start(authorization: string | undefined, input: IntentExecutionInput): void {
    void this.run(authorization, input).catch(async (error) => {
      await this.finish(authorization, input.intentId, {
        status: "FAILED",
        reason: clamp(humanizeLlmError(error)),
      });
    });
  }

  async run(authorization: string | undefined, input: IntentExecutionInput): Promise<void> {
    const result = await this.quoteAgent.run(authorization, {
      rawText: quoteRawText(input.text, input.context),
      ...(customerIdOf(input.context) ? { customerId: customerIdOf(input.context) } : {}),
      currency: "CNY",
    });
    await this.finish(authorization, input.intentId, intentOutcomeFromQuoteResult(result));
  }

  private async finish(
    authorization: string | undefined,
    intentId: string,
    outcome: IntentOutcome,
  ): Promise<void> {
    try {
      await this.human.run(authorization, this.fallbackKernel, async (kernel) => {
        if (outcome.status === "SUCCEEDED") {
          await kernel.intent.markSucceeded(intentId, outcome.draft);
        } else if (outcome.status === "NEEDS_INPUT") {
          await kernel.intent.markNeedsInput(intentId, outcome.reason);
        } else {
          await kernel.intent.markFailed(intentId, outcome.reason);
        }
      });
    } catch {
      // 用户已撤销 / 状态已超时：保留用户可见的终态，执行结果不再覆盖。
    }
  }
}
