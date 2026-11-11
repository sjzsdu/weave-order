import { z } from "zod";
import { toolResultSchema } from "../common";
import { EntityId, SampleShipment, Timestamp } from "../domain";
import { CreateSampleShipmentInput } from "../kernel";

/**
 * T-005 create_sample_shipment —— 寄样跟进智能体创建寄样单。
 *
 * 输入即内核契约（同一个 Schema），输出永远是 `DRAFT` 状态的寄样单：
 * 智能体不能直接创建已确认的寄样单，必须由人类在审批窗口调用内核 confirm。
 */
export const T005CreateSampleShipmentInput = CreateSampleShipmentInput;
export type T005CreateSampleShipmentInput = z.infer<typeof T005CreateSampleShipmentInput>;

/** 内核在创建草稿时同时给出跟进建议时间（由内核时钟计算，非 LLM）。 */
export const T005CreateSampleShipmentData = z.object({
  shipment: SampleShipment,
  followupSuggestedAt: Timestamp,
});
export type T005CreateSampleShipmentData = z.infer<typeof T005CreateSampleShipmentData>;

export const T005CreateSampleShipmentResult = toolResultSchema(T005CreateSampleShipmentData);
export type T005CreateSampleShipmentResult = z.infer<typeof T005CreateSampleShipmentResult>;

/** 确认寄样单的输入属于内核契约，工具层只做转发。 */
export const T005ConfirmSampleShipmentInput = z.object({ shipmentId: EntityId }).strict();
export type T005ConfirmSampleShipmentInput = z.infer<typeof T005ConfirmSampleShipmentInput>;
