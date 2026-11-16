import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";

/**
 * 意图通道契约。
 *
 * 「说点什么」提交的每一句话都先落成一条可追踪的意图，状态机与结果都在服务端，
 * 前端只负责展示。这样刷新页面、重启服务、换设备都不会丢失「我说过什么」。
 */

/** 提交入口：页内 composer / 顶栏 ⌘K / 客户 360 的快捷动作。 */
export const IntentSource = z.enum(["today", "command-bar", "customer-360"]);
export type IntentSource = z.infer<typeof IntentSource>;

/**
 * 状态机：QUEUED → RUNNING → SUCCEEDED | FAILED；任何时候可 CANCELLED；
 * RUNNING 超过 60 秒由服务端改写为 TIMEOUT。
 */
export const IntentStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
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

/** 执行成功产出的草稿指针。只允许指向当前产品里真实存在的审批对象。 */
export const IntentDraft = z
  .object({
    kind: z.enum(["quote"]),
    id: EntityId,
    title: z.string().min(1).max(255),
  })
  .strict();
export type IntentDraft = z.infer<typeof IntentDraft>;

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
