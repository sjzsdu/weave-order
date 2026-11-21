import type { AuditLogEntry } from "./kernel";
import type { MemberRole } from "./tenancy";

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
  QUOTE_SHARING_UPDATED: "更新了客户报价链接开关",
  SALES_CONTACT_UPDATED: "更新了业务员联系方式",
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
  PRINT_SAMPLE_CARD_REPRINTED: "补打了样卡",
  PRINT_DISCREPANCY_FLAGGED: "标记了打印差异",
  PRINT_SCAN_RECORDED: "记录了扫码",
  // 字段选项 / 多联系人 / 客户档案 / 成员权限（WAN-176）
  FIELD_OPTION_CREATED: "新增了字段选项",
  FIELD_OPTION_UPDATED: "修改了字段选项",
  FIELD_OPTION_DELETED: "停用了字段选项",
  FIELD_OPTION_MERGED: "合并了字段选项",
  FIELD_OPTION_REORDERED: "调整了字段选项顺序",
  CONTACT_CREATED: "新增了联系人",
  CONTACT_UPDATED: "修改了联系人",
  CONTACT_ARCHIVED: "归档了联系人",
  CONTACT_PRIMARY_CHANGED: "更换了主要联系人",
  CUSTOMER_RENAMED: "修改了客户名称",
  CUSTOMER_TIER_CHANGED: "调整了客户等级",
  CUSTOMER_OWNER_CHANGED: "更换了客户负责人",
  CUSTOMER_DRAFT_CREATED: "从原件建了客户草稿",
  CUSTOMER_CONFIRMED: "确认客户可用",
  CUSTOMER_FIELDS_UPDATED: "逐字段确认了客户信息",
  CUSTOMER_MERGED: "合并了重复客户",
  CUSTOMER_MERGE_UNDONE: "撤销了客户合并",
  SAMPLE_DRAFT_CREATED: "从标签建了样品草稿",
  SAMPLE_CONFIRMED: "确认样品可用",
  SAMPLE_FIELDS_UPDATED: "逐字段确认了样品信息",
  ITEM_CREATED: "创建了业务事项",
  ITEM_STATUS_CHANGED: "变更了事项状态",
  ITEM_COMPLETED: "完成了业务事项",
  MEMBERSHIP_ROLE_CHANGED: "调整了成员角色",
  MEMBERSHIP_SCOPE_CHANGED: "调整了成员数据范围",
  MEMBERSHIP_LIMIT_CHANGED: "调整了成员审批额度",
  IMPORT_COMPLETED: "完成了数据导入",
  AUDIT_EXPORTED: "导出了操作日志",
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

/**
 * 成员角色 → 中文。
 *
 * 三端各留一份必然会漂移（settings 与 tenant-switch 之前就有两份），
 * 所以这里是唯一来源；英文枚举不允许直接出现在界面上。
 */
export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  OWNER: "负责人",
  MANAGER: "经理",
  SALES: "销售",
  MERCHANDISER: "跟单",
  SAMPLE_ADMIN: "样品管理",
  FINANCE: "财务",
  VIEWER: "只读",
};

export function memberRoleLabel(role: string | null | undefined): string {
  if (!role) return "成员";
  return MEMBER_ROLE_LABEL[role as MemberRole] ?? "成员";
}

/**
 * 审计实体的中文名。
 *
 * 账本里的 `entity_type` 是内部表名（`sample_shipment_items` 之类），
 * 直接渲染等于把数据库结构摊给用户看。未收录的实体统一说「业务记录」。
 */
export const AUDIT_ENTITY_LABEL: Record<string, string> = {
  customer: "客户",
  customer_context: "客户背景",
  customer_contact: "联系人",
  field_option: "字段选项",
  item: "业务事项",
  sample: "样品",
  sample_image: "样品图片",
  sample_shipment: "寄样单",
  quote: "报价",
  quote_item: "报价明细",
  quote_share: "客户报价链接",
  order: "订单",
  order_item: "订单明细",
  shipment: "发货单",
  shipment_item: "发货明细",
  receivable: "应收",
  receivable_payment: "回款",
  revision_request: "改稿请求",
  pricing_policy: "报价策略",
  membership: "成员",
  tenant: "公司",
  intent: "一句话意图",
  llm_settings: "智能体设置",
  api_token: "接口凭据",
  print_job: "打印任务",
  print_template: "打印模板",
  print_agent: "打印代理",
  print_box: "箱",
  scan_event: "扫码记录",
  audit_log: "审计记录",
  document_snapshot: "单据快照",
};

export const UNKNOWN_AUDIT_ENTITY_LABEL = "业务记录";

export function auditEntityLabel(entityType: string | null | undefined): string {
  if (!entityType) return UNKNOWN_AUDIT_ENTITY_LABEL;
  return AUDIT_ENTITY_LABEL[entityType] ?? UNKNOWN_AUDIT_ENTITY_LABEL;
}

/**
 * 审计 before/after 的字段名 → 中文。
 *
 * 账本字段是内核写下的英文键（`costFloorAmount`），直接渲染等于把表结构摊给用户。
 * 未收录的键回落到原文而不是「字段」——至少能看出改的是哪一列。
 */
export const AUDIT_FIELD_LABEL: Record<string, string> = {
  code: "编号",
  name: "名称",
  label: "名称",
  tier: "客户等级",
  status: "状态",
  category: "品类",
  composition: "成分",
  unit: "单位",
  costFloorAmount: "成本低价",
  costFloorCurrency: "成本币种",
  amount: "金额",
  currency: "币种",
  unitPriceAmount: "单价",
  total: "合计",
  totalAmount: "总额",
  quantity: "数量",
  value: "取值",
  key: "策略键",
  priority: "优先级",
  locked: "是否锁定",
  phone: "手机",
  email: "邮箱",
  wechat: "微信",
  role: "角色",
  note: "备注",
  isPrimary: "主要联系人",
  active: "启用",
  sortOrder: "排序",
  trackingNumber: "运单号",
  paidAmount: "已收金额",
  dueDate: "交期",
  archivedAt: "归档时间",
  actorName: "操作人",
  reviewerName: "审批人",
};

export function auditFieldLabel(field: string): string {
  return AUDIT_FIELD_LABEL[field] ?? field;
}

/** 审计可见范围：「全公司」/「我的操作」，页面顶部与导出说明共用。 */
export function auditScopeLabel(scope: "ALL" | "OWN"): string {
  return scope === "ALL" ? "全公司" : "我的操作";
}
