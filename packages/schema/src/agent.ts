import { z } from "zod";
import { EntityId, Timestamp } from "./domain";

/**
 * 寄样跟进智能体的契约。
 *
 * 这些结构是「智能体状态 / 建议 / 信号」的公共表示：
 * 节点只负责编排，物流查询、回复来源、LLM 判断都在各自 provider 后面，
 * 因此后续接真实物流、微信、邮件时不需要改图。
 */

export const AgentStage = z.enum([
  "NEW",
  "SHIPMENT_DRAFTED",
  "TRACKED",
  "FOLLOWUP_SUGGESTED",
  "WAITING_REPLY",
  "REPLY_RECEIVED",
  "QUOTE_DRAFTED",
  "DONE",
  "FAILED",
]);
export type AgentStage = z.infer<typeof AgentStage>;

export const TrackingStatus = z.enum([
  "CREATED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
]);
export type TrackingStatus = z.infer<typeof TrackingStatus>;

export const TrackingEvent = z
  .object({
    at: Timestamp,
    description: z.string().min(1).max(200),
    location: z.string().max(128).nullable(),
  })
  .strict();
export type TrackingEvent = z.infer<typeof TrackingEvent>;

/** 物流 provider 的统一快照。真实快递 API 只需实现同一个接口。 */
export const TrackingSnapshot = z
  .object({
    carrier: z.string().min(1).max(64),
    trackingNumber: z.string().min(1).max(128),
    status: TrackingStatus,
    events: z.array(TrackingEvent).min(1),
    provider: z.string().min(1).max(64),
  })
  .strict();
export type TrackingSnapshot = z.infer<typeof TrackingSnapshot>;

export const FollowupChannel = z.enum(["WECHAT", "WECHAT_WORK", "EMAIL", "PHONE"]);
export type FollowupChannel = z.infer<typeof FollowupChannel>;

/**
 * 来自渠道的原始客户回复（微信 / 邮件 / 电话转写）。
 * 渠道适配器负责把原始报文解析成这个结构；意图判断由 LLM provider 完成。
 */
export const RawCustomerReply = z
  .object({
    id: EntityId,
    channel: FollowupChannel,
    text: z.string().min(1).max(2000),
    receivedAt: Timestamp,
  })
  .strict();
export type RawCustomerReply = z.infer<typeof RawCustomerReply>;

export const ReplyIntent = z.enum([
  "PRICE_REQUEST",
  "SAMPLE_FEEDBACK",
  "ACK",
  "NOT_INTERESTED",
  "OTHER",
]);
export type ReplyIntent = z.infer<typeof ReplyIntent>;

/** 客户回复识别结果：只会产生建议，不会直接改账本。 */
export const ReplyClassification = z
  .object({
    intent: ReplyIntent,
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(500),
    /** 只有 true 才会触发报价草稿（DRAFT） */
    quoteRequested: z.boolean(),
    provider: z.string().min(1).max(64),
  })
  .strict();
export type ReplyClassification = z.infer<typeof ReplyClassification>;

/** 跟进建议：智能体产出，停在建议态，等人类在审批窗口决定是否发送。 */
export const FollowupSuggestion = z
  .object({
    shipmentId: EntityId,
    channel: FollowupChannel,
    suggestedAt: Timestamp,
    message: z.string().min(1).max(1000),
    rationale: z.string().min(1).max(500),
    provider: z.string().min(1).max(64),
  })
  .strict();
export type FollowupSuggestion = z.infer<typeof FollowupSuggestion>;

/** 智能体失败记录：工具失败 / 非法状态跳转都落在这里，不伪造成功。 */
export const AgentFailure = z
  .object({
    node: z.string().min(1).max(64),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
    stage: AgentStage,
  })
  .strict();
export type AgentFailure = z.infer<typeof AgentFailure>;
