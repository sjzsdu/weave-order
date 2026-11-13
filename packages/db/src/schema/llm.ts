import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { JsonValue } from "@weave-order/schema";
import { llmScopeEnum, llmTaskEnum, tokenUsageStatusEnum } from "./enums";

/**
 * LLM 配置：GLOBAL 一行（tenant_id 为空）+ 每租户可选覆盖。
 * `key_ref` 只存引用（环境变量名 / KMS key），不落明文 Key。
 */
export const llmSettings = pgTable(
  "llm_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: llmScopeEnum("scope").notNull(),
    tenantId: uuid("tenant_id"),
    provider: varchar("provider", { length: 64 }).notNull().default("litellm"),
    baseUrl: varchar("base_url", { length: 512 }),
    defaultModel: varchar("default_model", { length: 128 }).notNull().default("deepseek-chat"),
    reasoningModel: varchar("reasoning_model", { length: 128 })
      .notNull()
      .default("deepseek-reasoner"),
    modelAllowlist: jsonb("model_allowlist").$type<JsonValue>().notNull().default([]),
    dailyTokenBudget: bigint("daily_token_budget", { mode: "number" }),
    monthlyTokenBudget: bigint("monthly_token_budget", { mode: "number" }),
    params: jsonb("params").$type<JsonValue>().notNull().default({}),
    keyRef: varchar("key_ref", { length: 255 }),
    allowExternal: boolean("allow_external").notNull().default(true),
    logPrompts: boolean("log_prompts").notNull().default(false),
    version: integer("version").notNull().default(1),
    updatedBy: varchar("updated_by", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("llm_settings_global_idx")
      .on(table.scope)
      .where(sql`${table.scope} = 'GLOBAL'`),
    uniqueIndex("llm_settings_tenant_idx")
      .on(table.tenantId)
      .where(sql`${table.scope} = 'TENANT'`),
    index("llm_settings_scope_tenant_idx").on(table.scope, table.tenantId),
  ],
);

/**
 * 单次模型调用用量：`request_id` 唯一，重试/重放不会重复计量。
 * 不存 prompt 原文，只存 SHA-256，满足「默认不落原文」。
 *
 * 生命周期：调用前插入 RESERVED（`reserved_tokens` 为预算占用上限），
 * 成功后按实际 usage 更新为 SETTLED 并释放预留；失败标记 FAILED 且保留预留额度——
 * 上游失败也可能已计费，不能因为本地异常让预算统计归零。
 */
export const tokenUsage = pgTable(
  "token_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    requestId: uuid("request_id").notNull(),
    task: llmTaskEnum("task").notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
    completionTokens: bigint("completion_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }),
    promptHash: varchar("prompt_hash", { length: 64 }).notNull(),
    /** 预算占用：RESERVED / FAILED 按它计入，SETTLED 归零后按实际 token 计入。 */
    reservedTokens: bigint("reserved_tokens", { mode: "number" }).notNull().default(0),
    status: tokenUsageStatusEnum("status").notNull().default("SETTLED"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("token_usage_request_id_idx").on(table.requestId),
    index("token_usage_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("token_usage_tenant_task_idx").on(table.tenantId, table.task),
    index("token_usage_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

/** 月度汇总：每次调用即时累加，每日可据此出成本看板（只计量，不计费）。 */
export const usageMonthly = pgTable(
  "usage_monthly",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** YYYY-MM-01 */
    period: date("period", { mode: "string" }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    task: llmTaskEnum("task").notNull(),
    requestCount: bigint("request_count", { mode: "number" }).notNull().default(0),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
    completionTokens: bigint("completion_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_monthly_tenant_period_model_task_idx").on(
      table.tenantId,
      table.period,
      table.model,
      table.task,
    ),
    index("usage_monthly_tenant_period_idx").on(table.tenantId, table.period),
  ],
);

export type LlmSettingsRow = typeof llmSettings.$inferSelect;
export type TokenUsageRow = typeof tokenUsage.$inferSelect;
export type UsageMonthlyRow = typeof usageMonthly.$inferSelect;
