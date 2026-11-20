import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";
import { IntentKind, IntentSource, IntentStatus, IntentUnderstanding, IntentView } from "./intents";
import type { IntentUnderstanding as IntentUnderstandingType } from "./intents";
import { OcrFailureCode, OcrStatus } from "./resources";

/**
 * 统一输入（`/inbound`）契约。
 *
 * 「一段话 + 几张图」先落成一条 `intents` 行，再由理解卡区分：
 * 报价 / 建样 / 建档。理解卡在用户 `start` 之前可以被 `revise` 纠正；
 * 执行阶段只做幂等资源草稿（客户/样品按 sourceId 去重），不重复建资源。
 */

/** 附件用途。`auto` 表示由服务端从文本 + OCR 结果判断；其余是客户端的明确提示。 */
export const InboundAttachmentKind = z.enum(["bizcard", "label", "fabric", "document", "auto"]);
export type InboundAttachmentKind = z.infer<typeof InboundAttachmentKind>;

/**
 * 客户端先走 `/api/media/presign`（purpose=inbound）直传，再把 objectKey 交上来。
 * 服务端不收外链或 base64：既避免 SSRF，也不把图片塞进 JSON。
 */
export const SubmitInboundAttachment = z
  .object({
    objectKey: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(128),
    byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    kind: InboundAttachmentKind.default("auto"),
  })
  .strict();
export type SubmitInboundAttachment = z.infer<typeof SubmitInboundAttachment>;

/**
 * `POST /api/inbound` 入参。
 *
 * 文本可以为空（纯图片输入），但文本与附件不能同时为空。
 */
export const SubmitInboundInput = z
  .object({
    text: z.string().trim().max(4000).optional(),
    source: IntentSource,
    clientRequestId: z.string().trim().min(8).max(128),
    attachments: z.array(SubmitInboundAttachment).max(20).optional(),
    /** 客户 360 / 客户行带来的上下文（客户 id、样品编号等），原样交给理解与执行。 */
    context: JsonValueSchema.optional(),
  })
  .strict()
  .refine((value) => (value.text?.trim().length ?? 0) > 0 || (value.attachments?.length ?? 0) > 0, {
    message: "请写一句话或至少上传一张图片/PDF",
    path: ["text"],
  });
export type SubmitInboundInput = z.infer<typeof SubmitInboundInput>;

/** 理解卡上的字段/任务类型定义在 `intents.ts`（意图契约的一部分），这里只做别名。 */
export { InboundFieldCard, InboundTask, InboundTaskKind, InboundTaskStatus } from "./intents";

/**
 * 理解卡快照。除基础四元组外，`fields` 逐字段给出出处与待补，
 * `tasks` 让「一张名片 + 一张标签」能显示成两件要做的事。
 */
export const InboundUnderstanding = IntentUnderstanding;
export type InboundUnderstanding = IntentUnderstandingType;

/** 附件处理视图：OCR 是否失败、失败码是什么。 */
export const InboundAttachmentView = z
  .object({
    sourceId: EntityId,
    kind: InboundAttachmentKind,
    mimeType: z.string().max(128).nullable(),
    ocrStatus: OcrStatus,
    failureCode: OcrFailureCode.nullable(),
    attempts: z.number().int().nonnegative(),
    textPreview: z.string().max(500).nullable(),
  })
  .strict();
export type InboundAttachmentView = z.infer<typeof InboundAttachmentView>;

/** `POST /api/inbound` 的回执：立刻可轮询的 id + 当时的意图快照。 */
export const SubmitInboundResult = z
  .object({
    inboundId: EntityId,
    status: IntentStatus,
    intent: IntentView,
  })
  .strict();
export type SubmitInboundResult = z.infer<typeof SubmitInboundResult>;

/** `GET /api/inbound/:id`：轮询理解与任务进度。 */
export const InboundDetail = z
  .object({
    intent: IntentView,
    understanding: InboundUnderstanding.nullable(),
    attachments: z.array(InboundAttachmentView),
    /** 可执行的动作由服务端给，前端不自己推断（例如已成功的报价不能再 start）。 */
    canStart: z.boolean(),
    canRevise: z.boolean(),
    createdAt: Timestamp,
  })
  .strict();
export type InboundDetail = z.infer<typeof InboundDetail>;

/**
 * 用户确认理解卡并触发执行。
 *
 * `fields` 只带本次修改过的字段：未提交的字段保持原值（含 PENDING），
 * 避免「确认一下」把未确认字段悄悄写成 CONFIRMED。
 */
export const StartInboundInput = z
  .object({
    kind: IntentKind.optional(),
    slots: z.record(z.string().max(64), JsonValueSchema).optional(),
    fields: z
      .array(
        z
          .object({
            fieldName: z.string().min(1).max(64),
            value: JsonValueSchema,
          })
          .strict(),
      )
      .max(60)
      .optional(),
  })
  .strict();
export type StartInboundInput = z.infer<typeof StartInboundInput>;

/** 纠正理解：只改理解卡，不执行；用户再次 start 才执行。 */
export const ReviseInboundInput = z
  .object({
    kind: IntentKind.optional(),
    slots: z.record(z.string().max(64), JsonValueSchema).optional(),
    fields: z
      .array(
        z
          .object({
            fieldName: z.string().min(1).max(64),
            value: JsonValueSchema.nullable(),
          })
          .strict(),
      )
      .max(60)
      .optional(),
  })
  .strict();
export type ReviseInboundInput = z.infer<typeof ReviseInboundInput>;
