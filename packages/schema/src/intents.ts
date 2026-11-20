import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";
import { ResourceFieldSourceKind, ResourceFieldStatus } from "./resources";

/**
 * 意图通道契约。
 *
 * 「说点什么」提交的每一句话都先落成一条可追踪的意图，状态机与结果都在服务端，
 * 前端只负责展示。这样刷新页面、重启服务、换设备都不会丢失「我说过什么」。
 */

/**
 * 提交入口：页内 composer / 顶栏 ⌘K / 客户 360 的快捷动作 /
 * 移动端拍照（`mobile-camera`）/ 上传图片或 PDF（`upload`）。
 *
 * 新增两个入口是 P0a「统一输入」的契约前提：手机拍名片与拖拽上传走同一条
 * 意图通道，服务端不为每个入口各写一套。
 */
export const IntentSource = z.enum([
  "today",
  "command-bar",
  "customer-360",
  "mobile-camera",
  "upload",
]);
export type IntentSource = z.infer<typeof IntentSource>;

/**
 * 状态机：QUEUED → RUNNING → SUCCEEDED | NEEDS_INPUT | FAILED；任何时候可 CANCELLED；
 * RUNNING 超过 60 秒由服务端改写为 TIMEOUT。NEEDS_INPUT 表示报价草稿还缺阻断项
 * （客户 / 样品 / 数量），不是失败，补齐后重试即可。
 */
export const IntentStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "NEEDS_INPUT",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
]);
export type IntentStatus = z.infer<typeof IntentStatus>;

/**
 * 执行器接线状态。`NOT_CONNECTED` 表示「小织的拆解服务尚未接入」：
 * 请求已被真实记录，但不会有任何自动结果，界面必须明说，不得伪装成功。
 */
export const IntentExecutorState = z.enum(["NOT_CONNECTED", "CONNECTED"]);
export type IntentExecutorState = z.infer<typeof IntentExecutorState>;

/**
 * 意图能产出的三类结果（文档 §5.1 的「理解卡」kind）：
 * 报价 / 建样 / 建档。`unknown` 只出现在理解阶段，不写进 `result`。
 */
export const IntentKind = z.enum(["quote", "sample", "customer", "unknown"]);
export type IntentKind = z.infer<typeof IntentKind>;

/**
 * 执行成功产出的草稿指针。
 * P0a 起泛化为「报价 / 建样 / 建档」，向后兼容：历史行只有 `kind=quote`。
 */
export const IntentDraft = z
  .object({
    kind: z.enum(["quote", "sample", "customer"]),
    id: EntityId,
    title: z.string().min(1).max(255),
  })
  .strict();
export type IntentDraft = z.infer<typeof IntentDraft>;

/**
 * 理解卡上的一个字段：值、出处、是否待补。
 *
 * `pending` 与 `required` 分开：克重/门幅不是报价阻塞项（可以先空着），
 * 但按 OCR spike 结论必须人工录入，所以 pending 且文案提示「不要猜」。
 */
export const InboundFieldCard = z
  .object({
    fieldName: z.string().min(1).max(64),
    label: z.string().min(1).max(64),
    value: JsonValueSchema,
    /** OCR / 人工 / 历史。理解卡必须让人看出这条值从哪来。 */
    sourceKind: ResourceFieldSourceKind,
    sourceId: EntityId.nullable(),
    status: ResourceFieldStatus,
    /** 该字段是否阻塞执行（如客户名、样品名、报价数量）。 */
    required: z.boolean(),
    /** OCR 未识别 / 按规则必须人工录入：UI 高亮为待补，且不得预填猜测值。 */
    pending: z.boolean(),
    /** 给用户的一句提示（「克重必须人工录入」）。 */
    help: z.string().max(200).nullable().default(null),
  })
  .strict();
export type InboundFieldCard = z.infer<typeof InboundFieldCard>;

/** 一条输入可以派生出多个任务；`sourceId` 指向产生它的原件。 */
export const InboundTaskKind = z.enum(["quote", "sample", "customer"]);
export type InboundTaskKind = z.infer<typeof InboundTaskKind>;

export const InboundTaskStatus = z.enum([
  "READY",
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "NEEDS_INPUT",
  "FAILED",
]);
export type InboundTaskStatus = z.infer<typeof InboundTaskStatus>;

export const InboundTask = z
  .object({
    kind: InboundTaskKind,
    sourceId: EntityId.nullable(),
    label: z.string().min(1).max(255),
    status: InboundTaskStatus,
    resourceId: EntityId.nullable().default(null),
    resourceType: z.enum(["customer", "sample", "quote", "item"]).nullable().default(null),
    message: z.string().max(500).nullable().default(null),
  })
  .strict();
export type InboundTask = z.infer<typeof InboundTask>;

/**
 * 理解卡快照：模型对这次输入的解读，用户在 `start` 之前确认或纠正。
 *
 * `slots` 是抽取到的槽位（客户名 / 样品名 / 数量 ...），`pendingQuestions`
 * 是必须由人补齐的问题。两者分开是因为「缺什么」不能藏进 `summary` 文案里，
 * 否则前端无法逐项纠正。
 */
export const IntentUnderstanding = z
  .object({
    kind: IntentKind,
    summary: z.string().min(1).max(500),
    slots: z.record(z.string().max(64), JsonValueSchema),
    pendingQuestions: z.array(z.string().min(1).max(255)).max(20),
    /** 逐字段的值与出处；未识别 / 必须人工录入的字段值为空且 pending=true。 */
    fields: z.array(InboundFieldCard).max(60).default([]),
    /** 一份输入可派生的多个任务（名片→建客户、标签→建样品、文本→报价）。 */
    tasks: z.array(InboundTask).max(10).default([]),
  })
  .strict();
export type IntentUnderstanding = z.infer<typeof IntentUnderstanding>;

export const SubmitIntentInput = z
  .object({
    text: z.string().trim().min(1, "请说点什么").max(4000),
    source: IntentSource,
    /**
     * 客户端生成的幂等键。同一次提交（含重复点击 / 断网重发）复用同一个值，
     * 服务端据此返回同一条 intent，不会堆出多条「等你决定」。
     */
    clientRequestId: z.string().trim().min(8).max(128),
    /** 客户 360 / 开张清单带过来的上下文，原样落库供执行器使用。 */
    context: JsonValueSchema.optional(),
    /**
     * 已上传成功的原件 ID（`sources`）。图片与 PDF 都先直传对象存储，
     * 再把 ID 挂在意图上；文本本身仍在 `text` 里，不重复存两份。
     */
    attachmentIds: z.array(EntityId).max(20).optional(),
  })
  .strict();
export type SubmitIntentInput = z.infer<typeof SubmitIntentInput>;

/** 意图读模型：前端渲染状态卡只需要这一个对象。 */
export const IntentView = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    text: z.string().min(1).max(4000),
    source: IntentSource,
    status: IntentStatus,
    /** 中文状态文案由服务端给，前端不自造（避免各端叫法不一致）。 */
    statusLabel: z.string().min(1).max(64),
    executorState: IntentExecutorState,
    /** 给人看的补充说明：未接入、失败原因、超时提示都走这里。 */
    notice: z.string().max(500).nullable(),
    failureReason: z.string().max(500).nullable(),
    draft: IntentDraft.nullable(),
    /** 关联的原件（`sources` ID，有序）。历史行没有附件，给默认空数组。 */
    attachments: z.array(EntityId).default([]),
    /** 理解卡快照；理解尚未产出时为空。 */
    understanding: IntentUnderstanding.nullable().default(null),
    /** 撤销截止时间；null 表示已不可撤销（终态或超过 10 分钟）。 */
    cancellableUntil: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
    cancelledAt: Timestamp.nullable(),
  })
  .strict();
export type IntentView = z.infer<typeof IntentView>;

/** POST /api/intents 的回执：intentId 供前端立刻渲染可追踪卡片。 */
export const SubmitIntentResult = z
  .object({
    intentId: EntityId,
    /** 顶层再给一次状态与说明，避免调用方为了渲染一行提示先解 intent。 */
    status: IntentStatus,
    executorState: IntentExecutorState,
    notice: z.string().max(500).nullable(),
    intent: IntentView,
  })
  .strict();
export type SubmitIntentResult = z.infer<typeof SubmitIntentResult>;

export const IntentListResponse = z.object({ items: z.array(IntentView) }).strict();
export type IntentListResponse = z.infer<typeof IntentListResponse>;
