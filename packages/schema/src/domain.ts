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
   * 图墙用的缩略图地址：服务端派生的 `_320.webp` 对象（本地 MinIO 与生产一致）。
   * 派生未完成 / 失败时回退原图地址，**必须**同时看 `thumbStatus`：
   * `failed` 表示这次回退不是「小图」，客户端要显式标注而不是假装有缩略图。
   */
  thumbUrl: z.string().url().nullable().default(null),
  /** 详情抽屉用的 `_640.webp` 地址；未就绪时为 null（前端回退 `url`）。 */
  detailUrl: z.string().url().nullable().default(null),
  /** 缩略图派生状态：pending（生成中）| ready（可缓存）| failed（回退原图，附原因）。 */
  thumbStatus: z.enum(["pending", "ready", "failed"]).default("pending"),
  /** 缩略图派生失败原因（截断）；ready 时为空。 */
  thumbError: z.string().nullable().default(null),
  variant: SampleImageVariant,
  isPrimary: z.boolean(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /**
   * 图像向量索引状态。图墙据此显示「检索中 / 索引失败」，
   * 不允许把「还没算向量」表现成「搜不到」。
   */
  indexStatus: z.enum(["pending", "ready", "failed"]).default("pending"),
  /** 索引失败原因（截断）；ready 时为空。 */
  indexError: z.string().nullable().default(null),
});
export type SampleImage = z.infer<typeof SampleImage>;

/** 数量：正数 + 单位。 */
export const Quantity = z.object({
  value: z.number().positive().max(1_000_000_000),
  unit: Unit,
});
export type Quantity = z.infer<typeof Quantity>;

/**
 * 客户等级 code：`field_options` 里 `customer.tier` 的稳定标识。
 *
 * 不再是封闭枚举：公司可以自定义等级（`T-` 前缀），预置项沿用旧枚举值
 * `NEW / REGULAR / VIP / COLD`，所以存量数据无需改写即可继续解析。
 */
export const CustomerTierCode = z.string().min(1).max(64);
export type CustomerTierCode = z.infer<typeof CustomerTierCode>;

/**
 * 资源生命周期状态（文档 §3.2），客户/样品/联系人共用同一组语义。
 *
 * `DRAFT`：OCR/输入产出，允许缺非关键字段，不参与去重建议与历史价取数；
 * `AVAILABLE`：用户确认后可参与报价与建议；
 * `ARCHIVED`：归档仍可读，但不进入新建议。
 */
export const ResourceStatus = z.enum(["DRAFT", "AVAILABLE", "ARCHIVED"]);
export type ResourceStatus = z.infer<typeof ResourceStatus>;

export const Customer = z.object({
  id: EntityId,
  /** 数据归属租户；由网关注入、内核落账，前端不得传。 */
  tenantId: EntityId,
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  tier: CustomerTierCode,
  /** 资源生命周期：草稿不参与去重建议与历史价取数。 */
  status: ResourceStatus,
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  /**
   * 主联系人投影。读模型可能已按查看者能力掩码（`z***@qinghe.com`），
   * 所以这里不能再做 email 格式校验；写入校验在 `CreateCustomerInput`。
   */
  contactEmail: z.string().max(255).nullable(),
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

/**
 * 样品状态。
 *
 * `ACTIVE` 是 P0a 前的历史取值，语义等价于 `AVAILABLE`：存量行默认仍是
 * `ACTIVE`，读模型与筛选也必须把它当「可用」处理。之所以不在这里直接改名，
 * 是因为库里已有大量 ACTIVE 行与按 ACTIVE 过滤的界面/HTTP 参数，一次性重写
 * 会留下一段「库是 AVAILABLE、界面按 ACTIVE 判断」的空窗期。
 * 这两个新取值随 P0a 契约冻结先行到位，数据重写与界面切换由 WAN-193 落地。
 */
export const SampleStatus = z.enum(["ACTIVE", "AVAILABLE", "DRAFT", "ARCHIVED"]);
export type SampleStatus = z.infer<typeof SampleStatus>;

/** 「可用」的样品状态：ACTIVE 是 AVAILABLE 的历史别名。 */
export function isSampleStatusAvailable(status: SampleStatus): boolean {
  return status === "ACTIVE" || status === "AVAILABLE";
}

/** 面料样品（完整实体，内核读写）。 */
export const FabricSample = z.object({
  id: EntityId,
  tenantId: EntityId,
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  composition: z.string().max(255).nullable(),
  category: z.string().max(64).nullable().optional(),
  /** 颜色原文；选项由 `field_options` 的 `sample.color` 治理。 */
  color: z.string().max(64).nullable().optional(),
  weight: z.string().max(64).nullable(),
  /** 从 `weight` 解析出的克重（g/m²）；解析不出为 null，不拿原文猜。 */
  weightGsm: z.number().int().positive().nullable().optional(),
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

/** `GET /api/samples` 筛选参数上限；HTTP 层与图墙选项共用同一组数字。 */
export const SAMPLE_FILTER_MAX_COMPOSITION_LENGTH = 64;
export const SAMPLE_FILTER_MAX_WEIGHT_TIERS = 10;
export const SAMPLE_FILTER_MAX_TIER_LENGTH = 64;
/** 颜色筛选可传来的值上限；与克重档位共用同一份限制。 */
export const SAMPLE_FILTER_MAX_COLORS = 10;
/** 图墙筛选器的选项条数上限；按出现次数倒序截断。 */
export const SAMPLE_FILTER_TIER_LIMIT = 24;

/**
 * 样品图墙筛选 query（`GET /api/samples`）。
 * `weights` 是逗号分隔的克重档位原文，拆分与中文错误文案在 HTTP 层做，
 * 这里只约束「允许出现哪些键」，避免客户端和服务端各写一份形状。
 */
export const SampleListQuery = z.object({
  composition: z.string().max(SAMPLE_FILTER_MAX_COMPOSITION_LENGTH).optional(),
  weights: z.string().optional(),
  /** 逗号分隔的颜色原文；与 `weights` 一样在 HTTP 层拆分与校验。 */
  colors: z.string().optional(),
  weightGsmMin: z.string().optional(),
  weightGsmMax: z.string().optional(),
});
export type SampleListQuery = z.infer<typeof SampleListQuery>;

/**
 * 图墙筛选器的选项，与 `categories` 同层返回。
 * 选项只来自当前租户 + 当前状态，不跟随 query / 已选 chip，
 * 否则选中一项会让它自己从选项里消失。
 */
export const SampleFilterTiers = z.object({
  compositions: z.array(z.string()),
  weights: z.array(z.string()),
  /** 颜色可选项：`field_options` 在用选项 + 存量原文里未入选项的值。 */
  colors: z.array(z.string()),
  /** 克重区间边界：来自当前租户可用样品的 `min/max(weight_gsm)`；无数据时为 null。 */
  weightGsmRange: z.object({ min: z.number().int(), max: z.number().int() }).strict().nullable(),
});
export type SampleFilterTiers = z.infer<typeof SampleFilterTiers>;

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
