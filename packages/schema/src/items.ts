import { z } from "zod";
import { EntityId, Quantity, Timestamp, Unit } from "./domain";

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

/** 事项最小必填集：缺任一字段就只返回「待补充」，不创建半成品事项。 */
export const ITEM_REQUIRED_FIELDS = ["customerId", "sampleId", "quantity"] as const;
export type ItemRequiredField = (typeof ITEM_REQUIRED_FIELDS)[number];

/**
 * 创建事项的输入。
 *
 * 三个必填项都允许缺省：内核先判断齐备性，缺字段返回 `NEEDS_INPUT`。
 * 把校验放在内核而不是 HTTP 层，是为了智能体/工具路径与人类路径同一套规则。
 */
export const CreateItemInput = z
  .object({
    customerId: EntityId.nullable().optional(),
    sampleId: EntityId.nullable().optional(),
    quantity: Quantity.nullable().optional(),
    currentStage: z.string().max(64).nullable().optional(),
    nextAction: z.string().max(255).nullable().optional(),
    sourceIntentId: EntityId.nullable().optional(),
  })
  .strict();
export type CreateItemInput = z.infer<typeof CreateItemInput>;

/**
 * 创建结果。
 * - `CREATED`：新建；
 * - `CONTINUED`：命中同客户+样品+数量且非终态的事项，返回已有 id（软提示，不是唯一约束）；
 * - `NEEDS_INPUT`：缺必填项，库里不会新增 items 行。
 */
export const ItemCreateOutcome = z.enum(["CREATED", "CONTINUED", "NEEDS_INPUT"]);
export type ItemCreateOutcome = z.infer<typeof ItemCreateOutcome>;

export const ItemCreateResult = z
  .object({
    outcome: ItemCreateOutcome,
    item: Item.nullable(),
    missingFields: z.array(z.enum(ITEM_REQUIRED_FIELDS)),
    /** 给用户看的一句话（「接续已有事项」/「还缺数量」），前端不自己拼。 */
    message: z.string().min(1).max(255),
  })
  .strict();
export type ItemCreateResult = z.infer<typeof ItemCreateResult>;

/** 事项详情里被引用的资源投影（只给展示需要的字段，不复制整份资源）。 */
export const ItemResourceRef = z
  .object({
    id: EntityId,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    status: z.enum(["DRAFT", "AVAILABLE", "ARCHIVED"]),
  })
  .strict();
export type ItemResourceRef = z.infer<typeof ItemResourceRef>;

export const ItemDetail = z
  .object({
    item: Item,
    customer: ItemResourceRef.nullable(),
    sample: ItemResourceRef.nullable(),
    /** 当前状态允许迁移到的状态（空数组 = 终态）。 */
    allowedTransitions: z.array(ItemStatus),
    undoToken: z.string().optional(),
    undoUntil: Timestamp.optional(),
  })
  .strict();
export type ItemDetail = z.infer<typeof ItemDetail>;

export const ItemListResponse = z
  .object({
    items: z.array(ItemDetail),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export type ItemListResponse = z.infer<typeof ItemListResponse>;

/** 显式迁移事项状态（完成走 `/items/:id/complete`，那里还要校验业务结果）。 */
export const TransitionItemInput = z
  .object({
    status: ItemStatus,
    /** 迁移原因（「客户还没给目标价」），写入审计，前端可空。 */
    note: z.string().max(500).nullable().optional(),
  })
  .strict();
export type TransitionItemInput = z.infer<typeof TransitionItemInput>;

export const UndoItemTransitionInput = z
  .object({ undoToken: z.string().min(1).max(8192) })
  .strict();
export type UndoItemTransitionInput = z.infer<typeof UndoItemTransitionInput>;
