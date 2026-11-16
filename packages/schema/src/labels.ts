import type { AuditLogEntry } from "./kernel";

/**
 * 审计动作 → 用户看得懂的中文。
 *
 * 这里是**唯一**一份：web、移动端、审批卡的审计轨迹都从这里取。
 * 之所以放在 schema 而不是各端 format.ts：三端各写一份必然会漂移，
 * 而审计文案一旦漏映射，用户直接看到 `QUOTE_REVISION_PROPOSED` 这类枚举。
 *
 * 新增 `AuditAction` 时同步补一行；没补也不会崩，兜底文案见
 * `UNKNOWN_AUDIT_ACTION_LABEL`。
 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  // 业务动作（与 api 的动态流白名单一致）
  CUSTOMER_CREATED: "新建了客户",
  CUSTOMER_CONTEXT_UPDATED: "更新了客户背景",
  SAMPLE_CREATED: "新建了样品",
  SAMPLE_UPDATED: "更新了样品",
  SAMPLE_ARCHIVED: "归档了样品",
  SAMPLE_IMAGE_ADDED: "给样品加了图片",
  SAMPLE_INDEX_FAILED: "样品图片索引失败",
  IMPORT_RESET: "重置了导入数据",
  SAMPLE_SHIPMENT_DRAFTED: "生成了寄样单草稿",
  SAMPLE_SHIPMENT_CONFIRMED: "确认了寄样单",
  SAMPLE_SHIPMENT_REJECTED: "驳回了寄样单",
  QUOTE_DRAFT_GENERATED: "生成了报价草稿",
  QUOTE_DRAFT_REVISED: "改了报价草稿",
  QUOTE_REVISION_PROPOSED: "发起了报价改稿",
  QUOTE_APPROVAL_ESCALATED: "把报价升级到上级复核",
  QUOTE_CONFIRMED: "报价已批准生效",
  QUOTE_REJECTED: "报价被驳回",
  REVISION_REQUESTED: "发起了改稿",
  REVISION_RESOLVED: "处理了改稿",
  INTENT_CANCELLED: "撤销了一条意图",
  ORDER_CREATED: "创建了订单",
  ORDER_CONFIRMED: "订单已确认",
  SHIPMENT_CREATED: "创建了发货单",
  SHIPMENT_CONFIRMED: "确认了发货",
  RECEIVABLE_CREATED: "建了应收",
  RECEIVABLE_PAYMENT_RECORDED: "登记了回款",
  QUOTE_SHARE_CREATED: "生成了客户报价链接",
  QUOTE_SHARE_REVOKED: "撤回了客户报价链接",
  // 系统 / 身份 / 运维动作：只在审计页出现，说清楚做了什么
  TENANT_CREATED: "创建了公司",
  TENANT_SWITCHED: "切换了公司",
  MEMBERSHIP_CREATED: "添加了成员",
  MEMBERSHIP_INVITED: "邀请了成员",
  MEMBERSHIP_ACTIVATED: "成员接受了邀请",
  MEMBERSHIP_REVOKED: "撤销了成员邀请",
  LLM_SETTINGS_UPDATED: "更新了智能体设置",
  PRICING_POLICY_CREATED: "建了报价策略",
  PRICING_POLICY_UPDATED: "更新了报价策略",
  DECISION_DELTA_RECORDED: "记录了决策偏差",
  USER_CREATED: "创建了账号",
  API_TOKEN_CREATED: "创建了接口凭据",
  API_TOKEN_REVOKED: "撤销了接口凭据",
  PRINT_AGENT_REGISTERED: "注册了打印代理",
  PRINT_AGENT_DISABLED: "停用了打印代理",
  PRINT_TEMPLATE_PUBLISHED: "发布了打印模板",
  PRINT_JOB_CREATED: "创建了打印任务",
  PRINT_JOB_COMPLETED: "打印任务已完成",
  PRINT_JOB_FAILED: "打印任务失败",
  PRINT_JOB_CANCELLED: "取消了打印任务",
  PRINT_BOX_CREATED: "创建了箱",
  PRINT_BOX_VOIDED: "作废了箱",
  PRINT_LABEL_REISSUED: "补打了标签",
  PRINT_DISCREPANCY_FLAGGED: "标记了打印差异",
  PRINT_SCAN_RECORDED: "记录了扫码",
};

/** 未映射动作的兜底：绝不把 SCREAMING_SNAKE 枚举直接丢到用户面前。 */
export const UNKNOWN_AUDIT_ACTION_LABEL = "更新了一条记录";

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? UNKNOWN_AUDIT_ACTION_LABEL;
}

/** 谁做的：账本只存 actorType，界面上不该出现 `AGENT` / `HUMAN` 原值。 */
export const ACTOR_TYPE_LABEL: Record<AuditLogEntry["actorType"], string> = {
  AGENT: "智能体",
  HUMAN: "人工",
  SYSTEM: "系统",
};

export function actorTypeLabel(actorType: string | null | undefined): string {
  if (!actorType) return "系统";
  return ACTOR_TYPE_LABEL[actorType as AuditLogEntry["actorType"]] ?? "系统";
}
