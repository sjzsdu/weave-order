import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { IntentDraft, IntentUnderstanding, JsonValue } from "@weave-order/schema";
import { intentSourceEnum, intentStatusEnum } from "./enums";

/**
 * 意图通道：用户说的一句话 = 一条有状态、可追踪、可撤销的记录。
 *
 * 为什么落库而不是放内存/队列：状态必须跨服务重启与部署存活，
 * 且「同一次提交」要能被幂等去重（`tenant_id + client_request_id` 唯一）。
 *
 * 状态机由 `kernel/intents.service.ts` 收口：
 * QUEUED → RUNNING → SUCCEEDED | NEEDS_INPUT | FAILED，任何非终态可 CANCELLED，
 * RUNNING 超过 60 秒改写为 TIMEOUT。NEEDS_INPUT = 报价还缺阻断项，不是失败。
 */
export const intents = pgTable(
  "intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** 客户端生成的幂等键；同一次提交（含重复点击）复用它。 */
    clientRequestId: varchar("client_request_id", { length: 128 }).notNull(),
    source: intentSourceEnum("source").notNull(),
    text: text("text").notNull(),
    /** 客户 360 / 开张清单带来的上下文，原样交给执行器。 */
    context: jsonb("context").$type<JsonValue>(),
    status: intentStatusEnum("status").notNull().default("QUEUED"),
    /**
     * 执行器接线状态。桌面「意图 → 报价 agent」执行器已接通（WAN-172），
     * 新提交会立刻转成 CONNECTED + RUNNING；历史 NOT_CONNECTED 行保持「待受理」文案。
     */
    executorState: varchar("executor_state", { length: 32 }).notNull().default("NOT_CONNECTED"),
    /** 失败 / 超时的人话原因。 */
    failureReason: text("failure_reason"),
    /** 成功产出的草稿指针（报价 / 建样 / 建档）。 */
    result: jsonb("result").$type<IntentDraft>(),
    /**
     * 关联原件（`sources` ID，有序）。多图分组假设靠这个数组传下去，
     * 不另建一张关联表：附件是先于结果存在的一次性输入，不需要跨意图复用。
     */
    attachments: uuid("attachments")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** 理解卡快照（kind / summary / slots / pendingQuestions），供用户确认或纠正。 */
    understanding: jsonb("understanding").$type<IntentUnderstanding>(),
    submittedBy: varchar("submitted_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [
    // 幂等的物理保证：重复提交只能命中这一行。
    uniqueIndex("intents_tenant_client_request_idx").on(table.tenantId, table.clientRequestId),
    index("intents_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("intents_tenant_status_idx").on(table.tenantId, table.status, table.updatedAt),
  ],
);
