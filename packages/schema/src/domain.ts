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
  amount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER, "金额超出安全整数范围（约 9007 万亿元分），拒绝该值"),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

/** 计量单位（纺织贸易常用）。 */
export const Unit = z.enum(["meter", "kilogram", "yard", "piece"]);
export type Unit = z.infer<typeof Unit>;

/** 样品图片用途。与数据库枚举 `sample_image_variant` 取值一致。 */
export const SampleImageVariant = z.enum(["primary", "angle", "detail", "swatch"]);
export type SampleImageVariant = z.infer<typeof SampleImageVariant>;

/**
 * 样品图片读模型：`url` 由服务端按 object_key 拼出（CDN 或签名 URL），
 * 客户端拿不到 object_key 也不需要知道桶在哪里。
 */
export const SampleImage = z.object({
  id: EntityId,
  url: z.string().url(),
  /**
   * 图墙用的缩略图地址。配了 CDN（`MEDIA_BASE_URL`）时带 `?w=320` 让 CDN 出缩略图，
   * 未配 CDN 时退回原图签名 URL —— 前端仍然按缩略尺寸渲染，不放大原图。
   */
  thumbUrl: z.string().url().nullable().default(null),
  variant: SampleImageVariant,
  isPrimary: z.boolean(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type SampleImage = z.infer<typeof SampleImage>;

/** 数量：正数 + 单位。 */
export const Quantity = z.object({
  value: z.number().positive().max(1_000_000_000),
  unit: Unit,
});
export type Quantity = z.infer<typeof Quantity>;

/** 客户等级。 */
export const CustomerTier = z.enum(["VIP", "REGULAR", "NEW", "COLD"]);
export type CustomerTier = z.infer<typeof CustomerTier>;

export const Customer = z.object({
  id: EntityId,
  /** 数据归属租户；由网关注入、内核落账，前端不得传。 */
  tenantId: EntityId,
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
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.lazy(() => JsonValueSchema)),
  z.record(
    z.string(),
    z.lazy(() => JsonValueSchema),
  ),
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
    .array(z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]))
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

/** 样品状态。 */
export const SampleStatus = z.enum(["ACTIVE", "ARCHIVED"]);
export type SampleStatus = z.infer<typeof SampleStatus>;

/** 面料样品（完整实体，内核读写）。 */
export const FabricSample = z.object({
  id: EntityId,
  tenantId: EntityId,
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  composition: z.string().max(255).nullable(),
  category: z.string().max(64).nullable().optional(),
  weight: z.string().max(64).nullable(),
  unit: Unit,
  /** 内核报价的价格底线（整数分）；低于此线一律 KERNEL_REJECTED。 */
  costFloor: Money.nullable(),
  status: SampleStatus,
  /** 图片读模型；读接口会带上，写回执 / 审批快照等旧路径可以不带。 */
  images: z.array(SampleImage).optional(),
  /** 主图 URL（`images` 里 `isPrimary` 那张）；无图时为 null。 */
  primaryImageUrl: z.string().url().nullable().default(null),
  createdAt: Timestamp,
});
export type FabricSample = z.infer<typeof FabricSample>;

/** 寄样单状态。智能体只能产出 DRAFT，人类确认后才进入 CONFIRMED。 */
export const SampleShipmentStatus = z.enum([
  "DRAFT",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
]);
export type SampleShipmentStatus = z.infer<typeof SampleShipmentStatus>;

/** 寄样渠道。 */
export const ShipmentChannel = z.enum(["COURIER", "EXPRESS", "HAND_CARRY"]);
export type ShipmentChannel = z.infer<typeof ShipmentChannel>;

/** 寄样单明细。 */
export const SampleShipmentItem = z.object({
  sampleId: EntityId,
  quantity: Quantity,
});
export type SampleShipmentItem = z.infer<typeof SampleShipmentItem>;

/** 寄样单（完整实体，内核读写）。 */
export const SampleShipment = z.object({
  id: EntityId,
  tenantId: EntityId,
  customerId: EntityId,
  status: SampleShipmentStatus,
  channel: ShipmentChannel,
  carrier: z.string().max(128).nullable(),
  trackingNumber: z.string().max(128).nullable(),
  note: z.string().max(2000).nullable(),
  items: z.array(SampleShipmentItem).min(1),
  confirmedBy: z.string().max(128).nullable(),
  confirmedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type SampleShipment = z.infer<typeof SampleShipment>;

/** 报价单状态。 */
export const QuoteStatus = z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]);
export type QuoteStatus = z.infer<typeof QuoteStatus>;
