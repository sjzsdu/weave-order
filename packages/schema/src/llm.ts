import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";

/**
 * LLM 网关与计量契约。
 *
 * 所有模型调用只经 LiteLLM（OpenAI 兼容协议），不直连厂商；
 * 这里冻结的是「配置 / 用量 / 预算」的公共表示，换 Router 时 agent 与工具层不改。
 */
export const LlmScope = z.enum(["GLOBAL", "TENANT"]);
export type LlmScope = z.infer<typeof LlmScope>;

/** 任务标签：不同任务可以路由到不同模型（日常 chat / 复杂 reasoner）。 */
export const LlmTask = z.enum([
  "QUOTE_INTENT",
  "QUOTE_DRAFT",
  "FOLLOWUP_SUGGESTION",
  "REPLY_CLASSIFICATION",
]);
export type LlmTask = z.infer<typeof LlmTask>;

export const LlmModelAllowlist = z.array(z.string().min(1).max(128)).max(50);
export type LlmModelAllowlist = z.infer<typeof LlmModelAllowlist>;

/**
 * `llm_settings` 行：全局参数 + 租户覆盖。
 * `keyRef` 只是密钥引用（环境变量名 / KMS key），禁止落明文 Key。
 */
export const LlmSettings = z
  .object({
    id: EntityId,
    scope: LlmScope,
    tenantId: EntityId.nullable(),
    provider: z.string().min(1).max(64),
    baseUrl: z.string().url().nullable(),
    defaultModel: z.string().min(1).max(128),
    reasoningModel: z.string().min(1).max(128),
    modelAllowlist: LlmModelAllowlist,
    /** 每日 token 预算；null = 不限额（仍会记账）。 */
    dailyTokenBudget: z.number().int().positive().nullable(),
    monthlyTokenBudget: z.number().int().positive().nullable(),
    params: z.record(z.string(), JsonValueSchema),
    keyRef: z.string().max(255).nullable(),
    allowExternal: z.boolean(),
    /** prompt 默认不落原文；该开关只允许平台端开启，且仍只记 hash。 */
    logPrompts: z.boolean(),
    version: z.number().int().positive(),
    updatedBy: z.string().max(128).nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type LlmSettings = z.infer<typeof LlmSettings>;

/** 租户覆盖更新：只允许改参数，不允许改 scope / tenantId。 */
export const UpdateLlmSettingsInput = z
  .object({
    provider: z.string().min(1).max(64).optional(),
    baseUrl: z.string().url().max(512).nullable().optional(),
    defaultModel: z.string().min(1).max(128).optional(),
    reasoningModel: z.string().min(1).max(128).optional(),
    modelAllowlist: LlmModelAllowlist.optional(),
    dailyTokenBudget: z.number().int().positive().nullable().optional(),
    monthlyTokenBudget: z.number().int().positive().nullable().optional(),
    params: z.record(z.string(), JsonValueSchema).optional(),
    keyRef: z.string().max(255).nullable().optional(),
    allowExternal: z.boolean().optional(),
    logPrompts: z.boolean().optional(),
  })
  .strict();
export type UpdateLlmSettingsInput = z.infer<typeof UpdateLlmSettingsInput>;

/** 合并全局 + 租户覆盖后的生效配置（带来源，可回答「为什么用这个模型」）。 */
export const ResolvedLlmSettings = z
  .object({
    provider: z.string(),
    baseUrl: z.string().url(),
    defaultModel: z.string(),
    reasoningModel: z.string(),
    modelAllowlist: LlmModelAllowlist,
    dailyTokenBudget: z.number().int().positive().nullable(),
    monthlyTokenBudget: z.number().int().positive().nullable(),
    params: z.record(z.string(), JsonValueSchema),
    keyRef: z.string().nullable(),
    allowExternal: z.boolean(),
    logPrompts: z.boolean(),
    version: z.number().int().positive(),
    /** 每个字段最终来自哪一层：GLOBAL / TENANT / ENV。 */
    sources: z.record(z.string(), z.enum(["GLOBAL", "TENANT", "ENV"])),
  })
  .strict();
export type ResolvedLlmSettings = z.infer<typeof ResolvedLlmSettings>;

/** 单次模型调用的用量事件（`token_usage`，request_id 幂等）。 */
export const TokenUsage = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    requestId: z.string().uuid(),
    task: LlmTask,
    model: z.string().min(1).max(128),
    provider: z.string().min(1).max(64),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    /** 采购成本（微元）。只用于成本看板，不计费给客户。 */
    costMicros: z.number().int().nonnegative().nullable(),
    /** prompt 的 SHA-256：默认不存原文，但能回答「发过什么」。 */
    promptHash: z.string().length(64),
    at: Timestamp,
  })
  .strict();
export type TokenUsage = z.infer<typeof TokenUsage>;

/** 每日调用上报的用量（写入前，网关内部使用）。 */
export const RecordTokenUsageInput = z
  .object({
    requestId: z.string().uuid(),
    task: LlmTask,
    model: z.string().min(1).max(128),
    provider: z.string().min(1).max(64),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative().default(0),
    costMicros: z.number().int().nonnegative().nullable().default(null),
    promptHash: z.string().length(64),
    at: Timestamp.optional(),
  })
  .strict();
export type RecordTokenUsageInput = z.infer<typeof RecordTokenUsageInput>;

/** `usage_monthly`：按 (租户, 月份, 模型, 任务) 聚合；每日调用即时累加。 */
export const UsageMonthly = z
  .object({
    tenantId: EntityId,
    /** YYYY-MM */
    period: z.string().regex(/^\d{4}-\d{2}$/),
    model: z.string(),
    task: LlmTask,
    requestCount: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    updatedAt: Timestamp,
  })
  .strict();
export type UsageMonthly = z.infer<typeof UsageMonthly>;

/** 预算状态，供 UI / 平台端展示；不计费。 */
export const LlmBudgetStatus = z
  .object({
    period: z.string(),
    dailyTokens: z.number().int().nonnegative(),
    monthlyTokens: z.number().int().nonnegative(),
    dailyBudget: z.number().int().positive().nullable(),
    monthlyBudget: z.number().int().positive().nullable(),
    dailyExceeded: z.boolean(),
    monthlyExceeded: z.boolean(),
  })
  .strict();
export type LlmBudgetStatus = z.infer<typeof LlmBudgetStatus>;
