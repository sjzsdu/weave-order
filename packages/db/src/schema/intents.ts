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
import type { IntentDraft, JsonValue } from "@weave-order/schema";
import { intentSourceEnum, intentStatusEnum } from "./enums";

/**
 * 意图通道：用户说的一句话 = 一条有状态、可追踪、可撤销的记录。
 *
 * 为什么落库而不是放内存/队列：状态必须跨服务重启与部署存活，
 * 且「同一次提交」要能被幂等去重（`tenant_id + client_request_id` 唯一）。
 *
 * 状态机由 `kernel/intents.service.ts` 收口：
 * QUEUED → RUNNING → SUCCEEDED | FAILED，任何非终态可 CANCELLED，
 * RUNNING 超过 60 秒改写为 TIMEOUT。
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
     * 执行器接线状态。当前产品没有接入真实的意图拆解执行器，
     * 新建行一律是 NOT_CONNECTED —— 界面据此说「尚未接入」而不是假成功。
     */
    executorState: varchar("executor_state", { length: 32 }).notNull().default("NOT_CONNECTED"),
    /** 失败 / 超时的人话原因。 */
    failureReason: text("failure_reason"),
    /** 成功产出的草稿指针（审批对象）。 */
    result: jsonb("result").$type<IntentDraft>(),
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
