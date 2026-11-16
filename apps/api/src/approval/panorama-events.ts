import { PanoramaEvent } from "@weave-order/schema";
import type { AuditAction, AuditLogEntry, PanoramaEvent as Event } from "@weave-order/schema";

/**
 * 业务事件流投影（只读、纯函数）。
 *
 * 把审计账本投影成「人话动态」：只保留人 / 智能体发起、且动作落在业务白名单
 * 里的记录；系统初始化事件（建公司、加成员、存 LLM 设置）继续留在 `audit`
 * 里给审计页，但不冒充智能体产出。
 *
 * 这里不写库、不读库，便于单测覆盖分型与过滤规则。
 */

/**
 * 业务动作白名单 + 中文短句。
 *
 * 故意不收录 TENANT_CREATED / MEMBERSHIP_* / TENANT_SWITCHED /
 * LLM_SETTINGS_UPDATED / API_TOKEN_* / PRINT_* 等系统与运维动作：
 * 新公司首屏的动态流必须是 0 条，而不是「小织建了公司」。
 */
const BUSINESS_ACTION_SUMMARY: Record<string, string> = {
  CUSTOMER_CREATED: "新建了客户",
  CUSTOMER_CONTEXT_UPDATED: "更新了客户背景",
  SAMPLE_CREATED: "新建了样品",
  SAMPLE_UPDATED: "更新了样品",
  SAMPLE_ARCHIVED: "归档了样品",
  SAMPLE_IMAGE_ADDED: "给样品加了图片",
  SAMPLE_SHIPMENT_DRAFTED: "生成了寄样单草稿",
  SAMPLE_SHIPMENT_CONFIRMED: "确认了寄样单",
  SAMPLE_SHIPMENT_REJECTED: "驳回了寄样单",
  QUOTE_DRAFT_GENERATED: "生成了报价草稿",
  QUOTE_DRAFT_REVISED: "改了报价草稿",
  QUOTE_REVISION_PROPOSED: "发起了报价改稿",
  QUOTE_APPROVAL_ESCALATED: "把报价升级到上级复核",
  QUOTE_CONFIRMED: "批准了报价",
  QUOTE_REJECTED: "驳回了报价",
  ORDER_CREATED: "创建了订单",
  ORDER_CONFIRMED: "订单成交",
  SHIPMENT_CREATED: "创建了发货单",
  SHIPMENT_CONFIRMED: "确认了发货",
  RECEIVABLE_CREATED: "建了应收",
  RECEIVABLE_PAYMENT_RECORDED: "登记了回款",
  REVISION_REQUESTED: "发起了改稿",
  REVISION_RESOLVED: "处理了改稿",
  QUOTE_SHARE_CREATED: "生成了客户报价链接",
  QUOTE_SHARE_REVOKED: "撤回了客户报价链接",
};

/** 白名单的稳定顺序：给 SQL `IN (...)` 与测试共用，避免两处漂移。 */
export const BUSINESS_AUDIT_ACTIONS = Object.keys(BUSINESS_ACTION_SUMMARY) as AuditAction[];

/** 里程碑不是「谁做了什么」，而是业务上值得单独标记的结果。 */
const MILESTONE_ACTIONS = new Set<string>([
  "QUOTE_CONFIRMED",
  "ORDER_CONFIRMED",
  "RECEIVABLE_PAYMENT_RECORDED",
]);

/** 智能体身份 → 同事名。人设由后端决定，前端不再按动作前缀猜。 */
const AGENT_ID_LABEL: Record<string, string> = {
  "quote-agent": "小织",
  "quoting-agent": "小织",
  "sample-followup-agent": "小跟",
  "inbound-intake-agent": "小跟",
};

export function isBusinessAction(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUSINESS_ACTION_SUMMARY, action);
}

export function businessActionSummary(action: string): string {
  return BUSINESS_ACTION_SUMMARY[action] ?? "更新了一条业务记录";
}

/**
 * 智能体署名：优先认身份，认不出再看动作归属，最后落到订单同事小序。
 * 这样新增智能体时即使忘了登记身份，也不会把动作记到错误的人头上。
 */
export function agentLabel(actorId: string, action: string): string {
  const byId = AGENT_ID_LABEL[actorId];
  if (byId) return byId;
  if (action.startsWith("SAMPLE_SHIPMENT")) return "小跟";
  if (action.startsWith("QUOTE") || action.startsWith("REVISION")) return "小织";
  return "小序";
}

/**
 * 人的署名。
 *
 * 账本只存 Casdoor `sub`，成员姓名没有落库（身份展示在 WAN-142 补），
 * 所以这里只区分「你」和「同事」，绝不把 UUID 当名字输出。
 */
function humanLabel(actorId: string, viewerActorId: string | null | undefined): string {
  return viewerActorId && actorId === viewerActorId ? "你" : "同事";
}

export interface PanoramaProjectionOptions {
  /** 当前登录者的 actor id（Casdoor sub），用于把「自己」写成「你」。 */
  viewerActorId?: string | null;
  /** 动态流最多保留多少条，默认 50。 */
  limit?: number;
}

const DEFAULT_EVENT_LIMIT = 50;

/** 投影单条审计；系统事件或白名单外动作返回 null（调用方负责丢弃）。 */
export function projectAuditEntry(
  entry: AuditLogEntry,
  options: PanoramaProjectionOptions = {},
): Event | null {
  if (entry.actorType === "SYSTEM") return null;
  if (!isBusinessAction(entry.action)) return null;

  const eventKind = MILESTONE_ACTIONS.has(entry.action)
    ? ("MILESTONE" as const)
    : entry.actorType === "AGENT"
      ? ("AGENT_DONE" as const)
      : ("HUMAN_DONE" as const);

  return PanoramaEvent.parse({
    id: entry.id,
    eventKind,
    actorType: entry.actorType,
    actorLabel:
      entry.actorType === "AGENT"
        ? agentLabel(entry.actorId, entry.action)
        : humanLabel(entry.actorId, options.viewerActorId),
    action: entry.action,
    summary: businessActionSummary(entry.action),
    entityType: entry.entityType,
    entityId: entry.entityId,
    createdAt: entry.createdAt,
  });
}

/** 按账本顺序（最新在前）投影一批审计，截到 limit。 */
export function projectPanoramaEvents(
  entries: AuditLogEntry[],
  options: PanoramaProjectionOptions = {},
): Event[] {
  const limit = options.limit ?? DEFAULT_EVENT_LIMIT;
  const events: Event[] = [];
  for (const entry of entries) {
    const event = projectAuditEntry(entry, options);
    if (event) events.push(event);
    if (events.length >= limit) break;
  }
  return events;
}

/** 业务时区固定东八区：账本时间是 UTC，但「今天」按使用者的自然日算。 */
const BUSINESS_TIMEZONE_OFFSET_HOURS = 8;

/** 今天 00:00（东八区）对应的 UTC 时刻，用于 todayAgentDoneCount。 */
export function startOfBusinessDay(now: Date): Date {
  const offsetMs = BUSINESS_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + offsetMs);
  const startShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(startShifted - offsetMs);
}
