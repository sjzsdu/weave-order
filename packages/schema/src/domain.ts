import { z } from "zod";

/** 实体 ID：PostgreSQL UUID。 */
export const EntityId = z.string().uuid();
export type EntityId = z.infer<typeof EntityId>;

/** ISO 8601 时间戳（UTC）。 */
export const Timestamp = z.string().datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** 币种（ISO 4217 三字母码）。 */
export const Currency = z.enum(["CNY", "USD", "EUR", "HKD"]);
export type Currency = z.infer<typeof Currency>;

/**
 * 金额：以最小货币单位（分）表示的整数。
 * 铁律：金额禁止浮点。任何小数金额直接落为 INVALID_INPUT 失败，
 * 既杜绝浮点精度问题，也让「金额只能由确定性内核计算」在类型层可判别。
 */
export const Money = z.object({
  amount: z.number().int().nonnegative(),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

/** 计量单位（纺织贸易常用）。 */
export const Unit = z.enum(["meter", "kilogram", "yard", "piece"]);
export type Unit = z.infer<typeof Unit>;

/** 数量：正数 + 单位。 */
export const Quantity = z.object({
  value: z.number().positive(),
  unit: Unit,
});
export type Quantity = z.infer<typeof Quantity>;

/** 客户等级。 */
export const CustomerTier = z.enum(["VIP", "REGULAR", "NEW", "COLD"]);
export type CustomerTier = z.infer<typeof CustomerTier>;

export const Customer = z.object({
  id: EntityId,
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  tier: CustomerTier,
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  contactEmail: z.string().email().nullable(),
});
export type Customer = z.infer<typeof Customer>;

/**
 * JSON 值：用于决策增量里 before/after 的异构值。
 * 用带类型的递归联合替代 any/unknown，保证「不留 any」且值结构可校验。
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.lazy(() => JsonValueSchema)),
  z.record(z.string(), z.lazy(() => JsonValueSchema)),
]);

/** 业务场景标签：决策增量所属的场景。 */
export const ScenarioTag = z.enum([
  "PRICING",
  "SAMPLE_FOLLOWUP",
  "ORDER_FOLLOWUP",
  "RECONCILIATION",
]);
export type ScenarioTag = z.infer<typeof ScenarioTag>;

/** 决策来源：智能体 or 人类。 */
export const DecisionActor = z.enum(["AGENT", "HUMAN"]);
export type DecisionActor = z.infer<typeof DecisionActor>;

/**
 * 决策增量：记录「智能体建议值」被「人类修改后值」覆盖的历史。
 * 这是 CustomerContext 的护城河核心 —— 产品越用越准的关键数据。
 */
export const DecisionDelta = z.object({
  id: EntityId,
  /** 被修改的字段名，如 "unitPrice" / "followupDate" */
  field: z.string().min(1).max(128),
  /** 智能体原始建议值 */
  originalValue: JsonValueSchema,
  /** 人类修改后的值 */
  modifiedValue: JsonValueSchema,
  scenarioTag: ScenarioTag,
  actor: DecisionActor,
  changedAt: Timestamp,
});
export type DecisionDelta = z.infer<typeof DecisionDelta>;

/** 报价响应模式：客户对报价的典型反应。 */
export const PricingBehavior = z.object({
  /** 价格敏感度 */
  sensitivity: z.enum(["HIGH", "MEDIUM", "LOW"]),
  /** 接受还价的概率 (0..1) */
  counterofferAcceptanceRate: z.number().min(0).max(1).nullable(),
  /** 典型成交窗口（天） */
  typicalAcceptanceWindowDays: z.number().int().positive().nullable(),
  notes: z.array(z.string().max(500)).default([]),
});
export type PricingBehavior = z.infer<typeof PricingBehavior>;

/** 付款行为。 */
export const PaymentPattern = z.object({
  preferredTerms: z.enum(["TT_ADVANCE", "TT_30D", "TT_60D", "LC", "DP"]).nullable(),
  /** 准时付款比例 (0..1) */
  onTimeRate: z.number().min(0).max(1).nullable(),
  /** 平均逾期天数 */
  averageDelayDays: z.number().int().nonnegative().nullable(),
  notes: z.array(z.string().max(500)).default([]),
});
export type PaymentPattern = z.infer<typeof PaymentPattern>;

/** 跟进偏好。 */
export const FollowupPreference = z.object({
  preferredChannel: z.enum(["WECHAT", "WECHAT_WORK", "EMAIL", "PHONE"]).nullable(),
  /** 偏好联系时段，如 "09:00-11:00" */
  preferredTimeWindow: z.string().max(64).nullable(),
  avoidDays: z
    .array(
      z.enum([
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
        "SUNDAY",
      ]),
    )
    .default([]),
  notes: z.array(z.string().max(500)).default([]),
});
export type FollowupPreference = z.infer<typeof FollowupPreference>;

/**
 * 客户私有上下文 —— 产品护城河核心。
 * 包含选样偏好、报价响应模式、付款行为、跟进偏好，
 * 以及人类修改智能体建议的决策增量历史。
 */
export const CustomerContext = z.object({
  customerId: EntityId,
  preferenceNotes: z.array(z.string().max(500)),
  pricingBehavior: PricingBehavior,
  paymentPattern: PaymentPattern,
  followupPreference: FollowupPreference,
  decisionDeltas: z.array(DecisionDelta),
  updatedAt: Timestamp,
});
export type CustomerContext = z.infer<typeof CustomerContext>;
