import { z } from "zod";
import { EntityId, JsonValue, JsonValueSchema, Timestamp } from "./domain";
import { AuditAction } from "./kernel";
import { MemberRole } from "./tenancy";

/**
 * 操作日志读取契约（WAN-179）。
 *
 * 与 `AuditLogEntry`（账本原始行）的区别：这里是「给人看」的读模型。
 * 列表项只带摘要，before/after 在点开某一行时再单独拉详情，避免一次把
 * 24 个月的 jsonb 全部吐给浏览器。
 */

/** 可见范围：全公司 / 仅自己的操作。由服务端按能力判定，前端只负责展示。 */
export const AuditLogScope = z.enum(["ALL", "OWN"]);
export type AuditLogScope = z.infer<typeof AuditLogScope>;

export const AuditLogListItem = z
  .object({
    seq: z.number().int().positive(),
    createdAt: Timestamp,
    actorType: z.enum(["AGENT", "HUMAN", "SYSTEM"]),
    actorId: z.string().min(1).max(128),
    actorName: z.string().max(128).nullable(),
    actorRole: MemberRole.nullable(),
    action: AuditAction,
    entityType: z.string().min(1).max(64),
    entityId: EntityId,
    entityLabel: z.string().max(255).nullable(),
    /** 批准、驳回、改价、删除、权限变更、选项变更等需要被单独盯住的动作。 */
    highRisk: z.boolean(),
    /** 一句话摘要，列表直接渲染；详细字段差异走详情接口。 */
    summary: z.string().max(512),
  })
  .strict();
export type AuditLogListItem = z.infer<typeof AuditLogListItem>;

export const AuditLogListResponse = z
  .object({
    scope: AuditLogScope,
    items: z.array(AuditLogListItem),
    /** 下一页游标 = 本页最后一条的 seq；null 表示没有更多。 */
    nextCursor: z.number().int().positive().nullable(),
  })
  .strict();
export type AuditLogListResponse = z.infer<typeof AuditLogListResponse>;

export const AuditLogDetail = AuditLogListItem.extend({
  /** 已按查看者能力裁剪；被裁剪的键名在 maskedFields 里列明。 */
  before: JsonValueSchema.nullable(),
  after: JsonValueSchema.nullable(),
  maskedFields: z.array(z.string()).max(100),
  correlationId: EntityId.nullable(),
}).strict();
export type AuditLogDetail = z.infer<typeof AuditLogDetail>;

export const AuditLogSummaryRange = z.enum(["7d", "30d", "90d", "12m", "all"]);
export type AuditLogSummaryRange = z.infer<typeof AuditLogSummaryRange>;

export const AuditLogSummaryDay = z
  .object({
    /** 北京时间自然日，YYYY-MM-DD。 */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const AuditLogSummary = z
  .object({
    scope: AuditLogScope,
    range: AuditLogSummaryRange,
    total: z.number().int().nonnegative(),
    highRiskCount: z.number().int().nonnegative(),
    days: z.array(AuditLogSummaryDay),
    actorTypes: z.array(
      z
        .object({
          actorType: z.enum(["AGENT", "HUMAN", "SYSTEM"]),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type AuditLogSummary = z.infer<typeof AuditLogSummary>;

export const AuditExportStatus = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);
export type AuditExportStatus = z.infer<typeof AuditExportStatus>;

export const AuditExportJob = z
  .object({
    id: EntityId,
    status: AuditExportStatus,
    rowCount: z.number().int().nonnegative().nullable(),
    /** 仅在 SUCCEEDED 时给短期签名下载地址。 */
    downloadUrl: z.string().nullable(),
    fileName: z.string().max(255).nullable(),
    error: z.string().max(1000).nullable(),
    createdAt: Timestamp,
    completedAt: Timestamp.nullable(),
    expiresAt: Timestamp,
  })
  .strict();
export type AuditExportJob = z.infer<typeof AuditExportJob>;

export const AuditExportJobResponse = z.object({ job: AuditExportJob }).strict();
export type AuditExportJobResponse = z.infer<typeof AuditExportJobResponse>;

/**
 * 高风险动作：列表上的红色标记与「只看高风险」筛选共用这一份。
 *
 * 口径（WAN-174 §3 / 巧匠修订）：批准、驳回、改价、删除/归档、权限变更、选项变更。
 * 新增动作时如果属于以上任何一类，必须加到这里，否则「只看高风险」会漏。
 */
export const AUDIT_HIGH_RISK_ACTIONS: readonly AuditAction[] = [
  // 批准 / 驳回
  "QUOTE_CONFIRMED",
  "QUOTE_REJECTED",
  "SAMPLE_SHIPMENT_CONFIRMED",
  "SAMPLE_SHIPMENT_REJECTED",
  // 改价：改稿会改金额；报价策略本身决定价格底线与跨人可见性
  "QUOTE_DRAFT_REVISED",
  "PRICING_POLICY_CREATED",
  "PRICING_POLICY_UPDATED",
  // 删除 / 归档 / 撤销
  "SAMPLE_ARCHIVED",
  "CONTACT_ARCHIVED",
  "FIELD_OPTION_DELETED",
  "PRINT_BOX_VOIDED",
  "MEMBERSHIP_REVOKED",
  "API_TOKEN_REVOKED",
  "QUOTE_SHARE_REVOKED",
  "IMPORT_RESET",
  // 权限变更
  "MEMBERSHIP_CREATED",
  "MEMBERSHIP_INVITED",
  "MEMBERSHIP_ROLE_CHANGED",
  "MEMBERSHIP_SCOPE_CHANGED",
  "MEMBERSHIP_LIMIT_CHANGED",
  // 字段选项变更（公司共享字典，改一次影响所有人）
  "FIELD_OPTION_CREATED",
  "FIELD_OPTION_UPDATED",
  "FIELD_OPTION_DELETED",
  "FIELD_OPTION_MERGED",
  "FIELD_OPTION_REORDERED",
];

const HIGH_RISK_SET: ReadonlySet<string> = new Set(AUDIT_HIGH_RISK_ACTIONS);

export function isHighRiskAuditAction(action: string): boolean {
  return HIGH_RISK_SET.has(action);
}

/** 被裁剪的敏感金额统一替换成同一句话：不暴露原值，也不假装字段不存在。 */
export const AUDIT_MASKED_PRICE = "价格已修改";

const COST_PRICE_KEY =
  /^(cost|unitCost|purchasePrice|supplierPrice|floorPrice|floorAmount|minPrice)/i;
const PRICING_POLICY_ENTITY = "pricing_policy";

export interface MaskAuditOptions {
  /** 查看者是否具备 `sample.cost.view`。 */
  allowCost: boolean;
  /** 查看者是否具备 `pricing.cross_person.read`。 */
  allowPricing: boolean;
  entityType: string;
}

export interface MaskedAuditSnapshot {
  value: JsonValue;
  maskedFields: string[];
}

/**
 * 服务端裁剪 before/after 里的成本价与客户底价。
 *
 * 必须服务端做：前端遮罩只是视觉，接口一抓包就漏。裁剪后仍保留键名，
 * 让用户知道「这里改过价」，而不是字段凭空消失。
 */
export function maskAuditSnapshot(
  snapshot: JsonValue,
  options: MaskAuditOptions,
): MaskedAuditSnapshot {
  const maskedFields: string[] = [];

  const walk = (value: JsonValue, path: string): JsonValue => {
    if (Array.isArray(value)) {
      return value.map((entry, index) => walk(entry, `${path}[${index}]`));
    }
    if (value === null || typeof value !== "object") return value;

    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const fullPath = path ? `${path}.${key}` : key;
      const sensitive =
        (!options.allowCost && COST_PRICE_KEY.test(key)) ||
        (!options.allowPricing && options.entityType === PRICING_POLICY_ENTITY && key === "value");
      if (sensitive) {
        out[key] = AUDIT_MASKED_PRICE;
        maskedFields.push(fullPath);
        continue;
      }
      out[key] = walk(entry, fullPath);
    }
    return out;
  };

  return { value: walk(snapshot, ""), maskedFields };
}

export interface AuditFieldDiff {
  field: string;
  before: JsonValue;
  after: JsonValue;
}

/**
 * 字段级差异：只比较顶层键，嵌套对象整体按值比较（展示为格式化 JSON）。
 * 账本里 before/after 都是内核写的扁平快照，不做深递归才能保持「可读」。
 */
export function diffAuditSnapshots(before: JsonValue, after: JsonValue): AuditFieldDiff[] {
  const left = asRecord(before);
  const right = asRecord(after);
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
  const diffs: AuditFieldDiff[] = [];
  for (const key of keys) {
    const a = left[key] ?? null;
    const b = right[key] ?? null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    diffs.push({ field: key, before: a, after: b });
  }
  return diffs;
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

/** 字段值的统一展示：null 用破折号，布尔用中文，对象用紧凑 JSON。 */
export function formatAuditValue(value: JsonValue): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return value.length > 0 ? value : "—";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * 导出请求体：与列表筛选同形，避免前端为「导出当前筛选」再拼一套参数。
 * `action` 用数组（可多选），时间用 ISO 字符串由服务端解析并校验。
 */
export const AuditExportInput = z
  .object({
    from: Timestamp.optional(),
    to: Timestamp.optional(),
    actorId: z.string().min(1).max(128).optional(),
    actor: z.string().min(1).max(128).optional(),
    action: z.array(AuditAction).max(50).optional(),
    entityType: z.string().min(1).max(64).optional(),
    keyword: z.string().min(1).max(100).optional(),
    highRisk: z.boolean().optional(),
  })
  .strict();
export type AuditExportInput = z.infer<typeof AuditExportInput>;
