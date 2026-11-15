import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";

/**
 * 客户回复的录入方式（手工粘贴文本 / 上传截图）。
 * 这是「录入方式」，与 `RawCustomerReply.channel`（微信/邮件等触达渠道）是两回事。
 */
export const InboundChannel = z.enum(["manual", "screenshot"]);
export type InboundChannel = z.infer<typeof InboundChannel>;

/**
 * 落库的手工客户回复。
 * `text` 已经过隐私脱敏；`rawPayload` 保留原始来源（截图存 imageUrl 引用，文本为 null），
 * 便于溯源。幂等键为 `(tenantId, channel, externalId)`。
 */
export const InboundMessage = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    channel: InboundChannel,
    externalId: z.string().min(1).max(128),
    customerRef: z.string().max(128).nullable(),
    text: z.string().min(1).max(8000),
    receivedAt: Timestamp,
    rawPayload: JsonValueSchema,
    createdAt: Timestamp,
  })
  .strict();
export type InboundMessage = z.infer<typeof InboundMessage>;

/** 录入入口：手动粘贴文本（text）或上传截图（imageUrl），二者按 channel 二选一。 */
export const IngestReplyInput = z
  .object({
    channel: InboundChannel,
    externalId: z.string().min(1).max(128),
    customerRef: z.string().max(128).nullable().optional(),
    text: z.string().max(8000).optional(),
    imageUrl: z.string().max(512).optional(),
  })
  .strict();
export type IngestReplyInput = z.infer<typeof IngestReplyInput>;
