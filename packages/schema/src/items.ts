import { z } from "zod";
import { EntityId, Timestamp, Unit } from "./domain";

/**
 * 业务事项（Item）契约 —— P0a 的聚合根。
 *
 * 事项「引用」客户与样品，不拥有它们：资源是跨事项共享的独立聚合根，
 * 合并客户只发生在资源聚合内部，不扩散成跨事项的分布式事务。
 *
 * 创建不变量（由内核保证，契约只固化形状）：
 * - 只有「客户 + 样品 + 数量」齐备才创建事项，缺字段返回「待补充」而不是半成品行；
 * - 完成必须有可观察的业务结果（已确认报价 / 打印成功）。
 */

/** 事项状态机取值（文档 §3.2）。终态：COMPLETED / CLOSED。 */
export const ItemStatus = z.enum([
  "IN_PROGRESS",
  "WAITING_INPUT",
  "WAITING_DECISION",
  "COMPLETED",
  "CLOSED",
]);
export type ItemStatus = z.infer<typeof ItemStatus>;

/** 终态：进入后不再接受状态迁移，聚合只读。 */
export const ITEM_TERMINAL_STATUSES = [
  "COMPLETED",
  "CLOSED",
] as const satisfies readonly ItemStatus[];

export function isTerminalItemStatus(status: ItemStatus): boolean {
  return (ITEM_TERMINAL_STATUSES as readonly ItemStatus[]).includes(status);
}

export const Item = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    status: ItemStatus,
    /** 引用而非从属：客户被归档时事项仍可读（历史上确实报过价）。 */
    customerId: EntityId.nullable(),
    sampleId: EntityId.nullable(),
    /**
     * 数量以「千分之一单位」存整数，沿用现有金额/数量的整数纪律：
     * 1.5 米 = 1500。禁止浮点，避免前端与内核各算一套精度。
     */
    quantityMilli: z.number().int().nonnegative().nullable(),
    unit: Unit,
    /** 展示用阶段文案（「正在核对价格」），由内核维护，前端不自造。 */
    currentStage: z.string().max(64).nullable(),
    /** 展示用下一步动作（「确认最终价格」）。 */
    nextAction: z.string().max(255).nullable(),
    /** 从哪次输入长出来；输入记录被清理后置空，事项本身仍在。 */
    sourceIntentId: EntityId.nullable(),
    createdBy: z.string().min(1).max(128),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type Item = z.infer<typeof Item>;

/** 事项列表筛选（`GET /items`）：默认最近事项，`mine` 为待我处理。 */
export const ItemListQuery = z
  .object({
    status: ItemStatus.optional(),
    filter: z.enum(["recent", "mine"]).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ItemListQuery = z.infer<typeof ItemListQuery>;

/**
 * 事项状态迁移表（唯一事实源）。
 * `WAITING_INPUT`（缺信息）与 `WAITING_DECISION`（有方案待拍板）是两种不同等待，
 * 不允许互相直连：前者补字段回 IN_PROGRESS，后者确认/改价回 IN_PROGRESS。
 */
export const ITEM_STATUS_TRANSITIONS: Readonly<Record<ItemStatus, readonly ItemStatus[]>> = {
  IN_PROGRESS: ["WAITING_INPUT", "WAITING_DECISION", "COMPLETED", "CLOSED"],
  WAITING_INPUT: ["IN_PROGRESS", "CLOSED"],
  WAITING_DECISION: ["IN_PROGRESS", "CLOSED"],
  COMPLETED: [],
  CLOSED: [],
};

export function canTransitionItemStatus(from: ItemStatus, to: ItemStatus): boolean {
  return ITEM_STATUS_TRANSITIONS[from].includes(to);
}
