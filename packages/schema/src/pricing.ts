import { z } from "zod";
import { EntityId, JsonValueSchema, Timestamp } from "./domain";
import { MemberRole } from "./tenancy";

/**
 * 定价继承链契约（T0 冻结后由 Track A 增量补齐，向后兼容）。
 *
 * 继承顺序：系统 → 公司 → 团队/客户/品类 → 个人。
 * `locked = true` 的是**管控类**策略：下级只能收紧，不能放宽。
 * 解析结果必须同时给出「生效值」和「来源」，审批卡上的每个数字都能点开
 * 看到是哪条策略、哪个层级给的。
 */

export const PricingScopeType = z.enum([
  "SYSTEM",
  "COMPANY",
  "TEAM",
  "CUSTOMER",
  "CATEGORY",
  "PERSON",
]);
export type PricingScopeType = z.infer<typeof PricingScopeType>;

/**
 * 策略键是封闭集合：新增键必须同时加在这里，避免数据库里出现
 * 前端读不懂的「野生 key」。
 */
export const PricingKey = z.enum([
  /** 最低毛利（百分比，管控类，只能收紧） */
  "pricing.min_margin_pct",
  /** 默认毛利（百分比，建议值） */
  "pricing.default_margin_pct",
  /** 公司成本底线（整数分，只允许抬高） */
  "pricing.cost_floor_amount",
  /** 改价幅度超过该百分比自动升级审批 */
  "pricing.reprice_escalation_pct",
  /** 改价金额超过该值（整数分）自动升级审批 */
  "pricing.reprice_escalation_amount",
  /** 业务员审批上限（整数分） */
  "approval.sales.limit",
  /** 主管审批上限（整数分；超出升级 owner） */
  "approval.manager.limit",
  /** 老板审批上限（整数分；null/缺省表示无上限） */
  "approval.owner.limit",
]);
export type PricingKey = z.infer<typeof PricingKey>;

/** 管控类键：下级只能收紧不能放宽。 */
export const CONTROL_PRICING_KEYS = [
  "pricing.min_margin_pct",
  "pricing.cost_floor_amount",
  "approval.sales.limit",
  "approval.manager.limit",
  "approval.owner.limit",
] as const satisfies readonly PricingKey[];

export type ControlPricingKey = (typeof CONTROL_PRICING_KEYS)[number];

export function isControlPricingKey(key: PricingKey): key is ControlPricingKey {
  return (CONTROL_PRICING_KEYS as readonly string[]).includes(key);
}

/**
 * 数值型策略值的宽松表示：
 * 既接受裸数字，也接受 `{ value }` / `{ amount }` / `{ marginPct }` 这类
 * 带单位的结构化值（对齐 product-design §10 的 value_json 约定）。
 */
export const PricingNumericValue = z.union([
  z.number().finite(),
  z.object({ value: z.number().finite(), unit: z.string().max(32).optional() }).strict(),
  z.object({ amount: z.number().finite(), unit: z.string().max(32).optional() }).strict(),
  z.object({ marginPct: z.number().finite(), unit: z.string().max(32).optional() }).strict(),
]);
export type PricingNumericValue = z.infer<typeof PricingNumericValue>;

/** 策略值：允许数字/布尔/字符串/结构化数字，拒绝数组与嵌套对象。 */
export const PricingPolicyValue = z.union([
  /** null 用于「无上限」（如 approval.owner.limit）。 */
  z.null(),
  PricingNumericValue,
  z.boolean(),
  z.string().max(255),
]);
export type PricingPolicyValue = z.infer<typeof PricingPolicyValue>;

/** 定价策略（tenant 级；SYSTEM 层用 scopeId = null）。 */
export const PricingPolicy = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    scopeType: PricingScopeType,
    scopeId: z.string().min(1).max(128).nullable(),
    key: PricingKey,
    value: PricingPolicyValue,
    /** 同层级冲突时的优先级，数值越大越优先。 */
    priority: z.number().int(),
    /** 管控层：下级不能放宽。 */
    locked: z.boolean(),
    effectiveFrom: Timestamp,
    createdBy: z.string().min(1).max(128),
    createdAt: Timestamp,
  })
  .strict();
export type PricingPolicy = z.infer<typeof PricingPolicy>;

export const CreatePricingPolicyInput = z
  .object({
    scopeType: PricingScopeType,
    scopeId: z.string().min(1).max(128).nullable().optional(),
    key: PricingKey,
    value: PricingPolicyValue,
    priority: z.number().int().min(0).max(1000).default(0),
    locked: z.boolean().default(false),
    effectiveFrom: Timestamp.optional(),
  })
  .strict();
export type CreatePricingPolicyInput = z.infer<typeof CreatePricingPolicyInput>;

export const UpdatePricingPolicyInput = z
  .object({
    value: PricingPolicyValue.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    locked: z.boolean().optional(),
    effectiveFrom: Timestamp.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.value !== undefined ||
      value.priority !== undefined ||
      value.locked !== undefined ||
      value.effectiveFrom !== undefined,
    { message: "至少更新一个字段" },
  );
export type UpdatePricingPolicyInput = z.infer<typeof UpdatePricingPolicyInput>;

/** 策略变更日志（只追加，审计的二级索引）。 */
export const PolicyChangeLog = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    policyId: EntityId,
    action: z.enum(["CREATED", "UPDATED", "DISABLED"]),
    oldValue: JsonValueSchema.nullable(),
    newValue: JsonValueSchema.nullable(),
    actorId: z.string().min(1).max(128),
    note: z.string().max(500).nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type PolicyChangeLog = z.infer<typeof PolicyChangeLog>;

/** 解析上下文：只带定位信息，数值一律由内核读库决定。 */
export const PricingContext = z
  .object({
    customerId: EntityId.optional(),
    teamId: EntityId.optional(),
    categoryId: z.string().min(1).max(64).optional(),
    personId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type PricingContext = z.infer<typeof PricingContext>;

/** 一条命中的策略在链上的角色。 */
export const PricingChainEntry = z
  .object({
    policyId: EntityId.nullable(),
    scopeType: PricingScopeType,
    scopeId: z.string().max(128).nullable(),
    value: PricingPolicyValue,
    priority: z.number().int(),
    locked: z.boolean(),
    /** 是否最终被采纳（管控夹取后可能未采纳）。 */
    applied: z.boolean(),
    note: z.string().max(255).nullable(),
  })
  .strict();
export type PricingChainEntry = z.infer<typeof PricingChainEntry>;

/** 出处：审批卡上的数字点开后看到的来源。 */
export const PricingSource = z
  .object({
    policyId: EntityId.nullable(),
    scopeType: PricingScopeType,
    scopeId: z.string().max(128).nullable(),
    priority: z.number().int(),
    locked: z.boolean(),
    /** `SYSTEM_DEFAULT` 表示没有任何租户策略命中，使用的是内核内置默认值。 */
    kind: z.enum(["POLICY", "SYSTEM_DEFAULT"]),
  })
  .strict();
export type PricingSource = z.infer<typeof PricingSource>;

/** 定价解析结果：生效值 + 来源 + 完整继承链。 */
export const ResolvedPricingValue = z
  .object({
    key: PricingKey,
    value: PricingPolicyValue,
    source: PricingSource,
    /** 是否被上级管控夹取（下级试图放宽被拦下）。 */
    clamped: z.boolean(),
    chain: z.array(PricingChainEntry),
  })
  .strict();
export type ResolvedPricingValue = z.infer<typeof ResolvedPricingValue>;

/** 审批层级：业务员 → 主管 → 老板。 */
export const ApprovalLevel = z.enum(["SALES", "MANAGER", "OWNER"]);
export type ApprovalLevel = z.infer<typeof ApprovalLevel>;

/** 审批升级原因，封闭集合。 */
export const EscalationReason = z.enum([
  "AMOUNT_OVER_LIMIT",
  "REPRICE_PCT_EXCEEDED",
  "REPRICE_AMOUNT_EXCEEDED",
  "COST_FLOOR_POLICY",
  "MANUAL_ESCALATION",
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

/**
 * 一条单据需要谁来批：金额阈值 + 改幅阈值共同决定。
 * `escalated = true` 表示不是由默认层级（SALES）直接审批。
 */
export const ApprovalRequirement = z
  .object({
    level: ApprovalLevel,
    role: MemberRole,
    amountCents: z.number().int().nonnegative(),
    changePctBps: z.number().int().nonnegative().nullable(),
    escalated: z.boolean(),
    reasons: z.array(EscalationReason),
    /** 每条阈值策略的生效值 + 来源，审批卡直接展示。 */
    policySources: z.array(ResolvedPricingValue),
  })
  .strict();
export type ApprovalRequirement = z.infer<typeof ApprovalRequirement>;

/** 角色审批等级排序：OWNER > MANAGER > SALES。 */
export function roleApprovalLevel(role: MemberRole): ApprovalLevel {
  if (role === "OWNER") return "OWNER";
  if (role === "MANAGER") return "MANAGER";
  if (role === "SALES" || role === "MERCHANDISER") return "SALES";
  if (role === "FINANCE") return "MANAGER";
  return "SALES";
}

export function approvalLevelRank(level: ApprovalLevel): number {
  return level === "OWNER" ? 3 : level === "MANAGER" ? 2 : 1;
}
