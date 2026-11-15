import { z } from "zod";
import { Currency, EntityId, JsonValueSchema, Quantity, Timestamp } from "./domain";
import { ReplyClassification } from "./agent";

/**
 * 客户回复的录入方式（手工粘贴文本 / 上传截图）。
 * 这是「录入方式」，与 `RawCustomerReply.channel`（微信/邮件等触达渠道）是两回事。
 */
export const InboundChannel = z.enum(["manual", "screenshot"]);
export type InboundChannel = z.infer<typeof InboundChannel>;

/**
 * 落库的手工客户回复。
 * `text` 已经过隐私脱敏；`rawPayload` 保留原始来源（截图只存 objectKey，文本为 null），
 * 便于溯源。幂等键为 `(tenantId, channel, externalId)`。
 * `rawPayloadExpiresAt` 之后由清理任务把 `rawPayload` 抹掉（默认 30 天，可配）。
 */
export const InboundMessage = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    channel: InboundChannel,
    externalId: z.string().min(1).max(128),
    /** 归属客户：时间线与手工回复取数都靠它，缺了就无法把回复挂到客户 360。 */
    customerId: EntityId,
    /** 关联寄样单（可选）：有线程时回复用于续跑跟进智能体。 */
    shipmentId: EntityId.nullable(),
    customerRef: z.string().max(128).nullable(),
    text: z.string().min(1).max(8000),
    receivedAt: Timestamp,
    rawPayload: JsonValueSchema,
    /** 原始 payload 的到期时间；文本录入无原始 payload 时为 null。 */
    rawPayloadExpiresAt: Timestamp.nullable(),
    /** 被跟进智能体取用后写入，保证一条回复只驱动一次识别。 */
    consumedAt: Timestamp.nullable(),
    /** 首次识别结论；重复提交时原样返回，不重复调用模型。 */
    classification: ReplyClassification.nullable(),
    /** 首次自动生成的报价草稿；重复提交时返回同一 id，不重复出草稿。 */
    quoteDraftId: EntityId.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type InboundMessage = z.infer<typeof InboundMessage>;

/**
 * 录入字段（不含落库派生字段）。
 *
 * 截图不再接受外链或 data URL：客户端先走 `/api/media/presign`（purpose=inbound）
 * 直传对象存储，再提交 `objectKey`。这样既不会把几百 KB 的 base64 塞进 JSON，
 * 也避免服务端替调用方去取任意 URL（SSRF）。
 */
const IngestReplyFields = z.object({
  channel: InboundChannel,
  externalId: z.string().min(1).max(128),
  customerId: EntityId,
  shipmentId: EntityId.nullable().optional(),
  customerRef: z.string().max(128).nullable().optional(),
  text: z.string().max(8000).optional(),
  /** `tenant/<tenantId>/inbound/<uuid>.<ext>`，由 presign 服务端生成。 */
  objectKey: z.string().min(1).max(512).optional(),
});

type IngestReplyShape = z.infer<typeof IngestReplyFields>;

/**
 * 渠道与内容必须严格对应：矛盾组合直接拒绝，不静默丢弃。
 * （评审 D6：channel=manual + objectKey、channel=screenshot + text 以前会被忽略。）
 */
function refineChannelContent(value: IngestReplyShape, ctx: z.RefinementCtx): void {
  if (value.channel === "manual") {
    if (!value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "文本录入必须提供 text",
      });
    }
    if (value.objectKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objectKey"],
        message: "文本录入不接受 objectKey",
      });
    }
    return;
  }
  if (!value.objectKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["objectKey"],
      message: "截图录入必须提供 objectKey",
    });
  }
  if (value.text) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text"],
      message: "截图录入不接受 text（以 OCR 结果为准）",
    });
  }
}

export const IngestReplyInput = IngestReplyFields.superRefine(refineChannelContent);
export type IngestReplyInput = z.infer<typeof IngestReplyInput>;

/**
 * 工作台「录入客户回复」的完整入参：录入字段 + 可选的报价上下文。
 *
 * `sampleId` 给了才会在识别为询价时自动生成报价草稿（T-006 定价 → T-004 草稿）；
 * 没给就只入库 + 识别，返回 `hint` 提示先选面料。
 */
export const InboundIntakeInput = IngestReplyFields.extend({
  sampleId: EntityId.optional(),
  quantity: Quantity.optional(),
  currency: Currency.default("CNY"),
  /** false = 只入库，不调用模型识别。默认 true。 */
  classify: z.boolean().default(true),
}).superRefine(refineChannelContent);
export type InboundIntakeInput = z.infer<typeof InboundIntakeInput>;

/** 录入结果：入库行 + 识别结论 + 可能生成的草稿。 */
export const InboundReplyResult = z
  .object({
    message: InboundMessage,
    classification: ReplyClassification.nullable(),
    quoteDraftId: EntityId.nullable(),
    /** 草稿生成失败的原因（入库与识别仍算成功），不伪造草稿。 */
    draftError: z.string().max(500).nullable(),
    hint: z.string().max(500).nullable(),
  })
  .strict();
export type InboundReplyResult = z.infer<typeof InboundReplyResult>;

/** 客户回复列表（时间线已单独合并，这里用于工作台最近录入）。 */
export const InboundReplyList = z.object({ messages: z.array(InboundMessage) }).strict();
export type InboundReplyList = z.infer<typeof InboundReplyList>;
