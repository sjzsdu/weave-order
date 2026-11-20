import { Injectable } from "@nestjs/common";
import {
  InboundIntakeInput,
  InboundMessage,
  InboundReplyResult,
  QuoteIntentExtraction,
} from "@weave-order/schema";
import type { Quantity } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { scopeWindowOf } from "../kernel";
import { createResilientLlmProvider } from "../platform/llm";
import type { LlmProvider } from "../platform/llm";
import { loadEnv } from "../platform/env";
import { createTools } from "../tools";

const DEFAULT_QUANTITY: Quantity = { value: 100, unit: "meter" };

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function isSimulated(provider: string): boolean {
  return provider.startsWith("local-");
}

/**
 * 工作台「录入客户回复」的编排层。
 *
 * 入库、脱敏、幂等都在内核；这里只做三件编排：
 * 1. 截图先经多模态 provider 抽文本（token 走 SCREENSHOT_OCR 同一计量）；
 * 2. 识别客户意图（`classifyReply`，与跟进图同一 provider）；
 * 3. 识别为询价且指定了面料时，复用 T-006 定价 + T-004 草稿（草稿恒 DRAFT，交人类审批）。
 *
 * 任何一步失败都不会伪造结果：入库成功但识别/草稿失败时，返回 `draftError` / `hint`。
 */
@Injectable()
export class InboundIntakeService {
  async run(kernel: Kernel, ctx: KernelContext, body: unknown): Promise<InboundReplyResult> {
    const input = InboundIntakeInput.parse(body);

    // 客户必须可见：否则会把回复挂到别人的客户上（数据范围由 ctx 决定）。
    await kernel.customers.getById(input.customerId, ctx);
    if (input.sampleId) await kernel.samples.getById(input.sampleId, ctx.actor.role);

    // 幂等重放：同 (channel, externalId) 直接返回首次处理结果，
    // 不再调用模型、不再生成第二份草稿（验收 3）。
    const existing = await kernel.inboundReplies.findByExternalId(input.channel, input.externalId);
    if (existing) {
      return InboundReplyResult.parse({
        message: existing,
        classification: existing.classification,
        quoteDraftId: existing.quoteDraftId,
        draftError: null,
        hint: "该消息已录入过，返回首次处理结果（未重复识别，也未重复生成报价草稿）。",
      });
    }

    const provider = await this.provider(kernel);
    let message = await kernel.inboundReplies.ingest(input, {
      ocr: (imageUrl) => provider.extractReplyFromImage({ imageUrl }),
    });

    let classification: InboundReplyResult["classification"] = null;
    let quoteDraftId: string | null = null;
    let draftError: string | null = null;
    let hint: string | null = null;

    if (!input.classify) {
      hint = "已记录到客户时间线；未做意图识别。";
      return InboundReplyResult.parse({ message, classification, quoteDraftId, draftError, hint });
    }

    try {
      classification = await provider.classifyReply({ text: message.text });
    } catch (error) {
      hint = `已记录到客户时间线，但意图识别失败：${messageOf(error)}`;
      return InboundReplyResult.parse({ message, classification, quoteDraftId, draftError, hint });
    }

    // 识别已完成：标记消费，避免这条回复再被跟进线程识别一次。
    await kernel.inboundReplies.markConsumed(message.id);
    message = InboundMessage.parse({
      ...message,
      consumedAt: new Date().toISOString(),
    });

    if (!classification.quoteRequested) {
      await kernel.inboundReplies.recordProcessing(message.id, {
        classification,
        quoteDraftId: null,
      });
      hint = `已识别为「${classification.summary}」，未触发生成报价草稿。`;
      return InboundReplyResult.parse({ message, classification, quoteDraftId, draftError, hint });
    }

    if (!input.sampleId) {
      await kernel.inboundReplies.recordProcessing(message.id, {
        classification,
        quoteDraftId: null,
      });
      hint = "已识别为询价。选择面料后重新提交，即可自动生成报价草稿。";
      return InboundReplyResult.parse({ message, classification, quoteDraftId, draftError, hint });
    }

    const tools = createTools(kernel);
    const agentCtx: KernelContext = {
      actor: { type: "AGENT", id: "inbound-intake-agent", role: ctx.actor.role },
      ...(scopeWindowOf(ctx) ?? {}),
    };

    let quantity = input.quantity ?? DEFAULT_QUANTITY;
    if (!input.quantity) {
      try {
        const intent: QuoteIntentExtraction = await provider.extractQuoteIntent({
          text: message.text,
        });
        if (intent.slots.quantity) quantity = intent.slots.quantity;
      } catch {
        // 数量抽取失败不阻断：用默认数量生成草稿，人类可在审批前改稿。
      }
    }

    try {
      const pricing = await tools.suggestLinePrice.execute(
        {
          customerId: message.customerId,
          fabricSampleId: input.sampleId,
          quantity,
          currency: input.currency,
        },
        agentCtx,
      );
      if (!pricing.ok) {
        draftError = `定价失败：${pricing.error.message}`;
      } else {
        const draft = await tools.generateQuoteDraft.execute(
          {
            customerId: message.customerId,
            currency: input.currency,
            validityDays: 30,
            remarks: [
              `手工录入客户回复自动生成（${input.channel === "screenshot" ? "截图 OCR" : "文本粘贴"}）`,
              `来源消息 ${message.id}`,
              `识别：${classification.provider}${isSimulated(classification.provider) ? "（模拟轨迹，非真实模型）" : ""}`,
            ].join("；"),
            items: [
              {
                fabricSampleId: input.sampleId,
                quantity,
                unitPrice: pricing.data.pricing.suggestedUnitPrice,
              },
            ],
          },
          agentCtx,
        );
        if (!draft.ok) {
          draftError = `草稿生成失败：${draft.error.message}`;
        } else {
          quoteDraftId = draft.data.draft.id;
          hint = isSimulated(classification.provider)
            ? "模拟识别（本地规则）已生成报价草稿，待确认。"
            : "已识别为询价并生成报价草稿，待确认。";
        }
      }
    } catch (error) {
      draftError = `草稿生成失败：${messageOf(error)}`;
    }

    await kernel.inboundReplies.recordProcessing(message.id, { classification, quoteDraftId });

    return InboundReplyResult.parse({
      message,
      classification,
      quoteDraftId,
      draftError,
      hint,
    });
  }

  /** provider 与报价 agent 同源：openai-compatible 企业网关，本地零 key 规则；截图必须真实视觉模型。 */
  private async provider(kernel: Kernel): Promise<LlmProvider> {
    const env = loadEnv();
    const settings = await kernel.llmSettings.resolve();
    const name =
      env.LLM_PROVIDER === "openai-compatible" && settings.allowExternal
        ? "openai-compatible"
        : "local-rule";
    return createResilientLlmProvider(name, { settings, usage: kernel.usage, env });
  }
}
