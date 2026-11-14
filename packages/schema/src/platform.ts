import { z } from "zod";
import { Currency, EntityId, JsonValueSchema, Timestamp } from "./domain";
import { IsolationMode } from "./tenancy";

/**
 * E4 平台总管理端（control plane）契约。
 *
 * 铁律：控制面只存账号 / 订阅 / 用量聚合 / 账单，**不存任何租户业务数据**
 * （客户、报价明细、样品图、手机号）。需要看业务单据只能走 break-glass。
 * 所有金额均为整数分，禁止浮点。
 */

/** 平台角色：最小 5 个，权限矩阵见 PLATFORM_PERMISSIONS。 */
export const PlatformRole = z.enum([
  "platform_owner",
  "platform_finance",
  "platform_support",
  "platform_ops",
  "platform_readonly",
]);
export type PlatformRole = z.infer<typeof PlatformRole>;

export const PlatformUserStatus = z.enum(["ACTIVE", "DISABLED"]);
export type PlatformUserStatus = z.infer<typeof PlatformUserStatus>;

export const PlatformUser = z
  .object({
    id: EntityId,
    subject: z.string().min(1).max(128),
    email: z.string().email(),
    name: z.string().min(1).max(255),
    role: PlatformRole,
    status: PlatformUserStatus,
    /** 平台端强制 MFA；Casdoor 应用 `weave-platform` 同样强制。 */
    mfaEnforced: z.boolean(),
    lastLoginAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type PlatformUser = z.infer<typeof PlatformUser>;

export const PlatformTenantStatus = z.enum([
  "TRIAL",
  "ACTIVE",
  "OVERDUE",
  "SUSPENDED",
  "CANCELLED",
]);
export type PlatformTenantStatus = z.infer<typeof PlatformTenantStatus>;

export const BillingCycle = z.enum(["MONTHLY", "ANNUAL"]);
export type BillingCycle = z.infer<typeof BillingCycle>;

export const SubscriptionStatus = z.enum(["TRIAL", "ACTIVE", "OVERDUE", "SUSPENDED", "CANCELLED"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const PlanStatus = z.enum(["ACTIVE", "RETIRED"]);
export type PlanStatus = z.infer<typeof PlanStatus>;

/** 套餐定义（价格另放版本化价格表，改价不发版）。 */
export const Plan = z
  .object({
    code: z.string().min(1).max(32),
    name: z.string().min(1).max(64),
    tier: z.number().int().min(0).max(9),
    seatMin: z.number().int().nonnegative(),
    seatMax: z.number().int().positive().nullable(),
    agentActionsQuota: z.number().int().nonnegative(),
    storageGb: z.number().int().nonnegative(),
    features: z.record(z.boolean()),
    status: PlanStatus,
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

export const PriceBookStatus = z.enum(["DRAFT", "ACTIVE", "RETIRED"]);
export type PriceBookStatus = z.infer<typeof PriceBookStatus>;

export const PriceBook = z
  .object({
    id: EntityId,
    version: z.number().int().positive(),
    status: PriceBookStatus,
    effectiveFrom: Timestamp,
    notes: z.string().max(1000).nullable(),
    createdBy: z.string().min(1),
    createdAt: Timestamp,
    activatedAt: Timestamp.nullable(),
  })
  .strict();
export type PriceBook = z.infer<typeof PriceBook>;

/** 价格以「每席位每月」为基准；年付按 annualPriceCents 收。 */
export const PlanPrice = z
  .object({
    planCode: z.string().min(1),
    monthlyPriceCents: z.number().int().nonnegative(),
    annualPriceCents: z.number().int().nonnegative(),
    currency: Currency,
  })
  .strict();
export type PlanPrice = z.infer<typeof PlanPrice>;

export const PriceBookDetail = z
  .object({
    book: PriceBook,
    prices: z.array(PlanPrice),
  })
  .strict();
export type PriceBookDetail = z.infer<typeof PriceBookDetail>;

export const TenantPriceOverride = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    planCode: z.string().min(1),
    monthlyPriceCents: z.number().int().nonnegative(),
    seats: z.number().int().positive().nullable(),
    effectiveFrom: Timestamp,
    effectiveTo: Timestamp.nullable(),
    reason: z.string().min(1).max(500),
    status: z.enum(["PENDING", "ACTIVE", "EXPIRED", "REVOKED"]),
    createdBy: z.string().min(1),
    approvedBy: z.string().nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type TenantPriceOverride = z.infer<typeof TenantPriceOverride>;

export const Subscription = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    planCode: z.string().min(1),
    priceBookId: EntityId,
    seats: z.number().int().positive(),
    billingCycle: BillingCycle,
    status: SubscriptionStatus,
    periodStart: Timestamp,
    periodEnd: Timestamp,
    trialEndsAt: Timestamp.nullable(),
    nextDueAt: Timestamp.nullable(),
    /** 生效合同月费（分；已考虑租户覆盖价）。 */
    effectiveMonthlyCents: z.number().int().nonnegative(),
    overrideId: EntityId.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type Subscription = z.infer<typeof Subscription>;

/** 用量日汇总（控制面只保留聚合，不保留业务明细）。 */
export const UsageDay = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    agentActions: z.number().int().nonnegative(),
    storageGb: z.number().nonnegative(),
    smsCount: z.number().int().nonnegative(),
    llmInputTokens: z.number().int().nonnegative(),
    llmOutputTokens: z.number().int().nonnegative(),
    llmCostCents: z.number().int().nonnegative(),
  })
  .strict();
export type UsageDay = z.infer<typeof UsageDay>;

export const UsageKind = z.enum(["agent_action", "storage", "sms", "llm_tokens"]);
export type UsageKind = z.infer<typeof UsageKind>;

/**
 * 用量事件：幂等键唯一，重放不会重复计量。
 * `storage` 的 quantity 为 GB（保留 3 位小数），`llm_tokens` 为 token 数，
 * `agent_action` / `sms` 为次数。
 */
export const UsageEventInput = z
  .object({
    tenantId: EntityId,
    kind: UsageKind,
    quantity: z.number().nonnegative(),
    idempotencyKey: z.string().min(8).max(128),
    occurredAt: Timestamp.optional(),
    meta: z.record(JsonValueSchema).optional(),
  })
  .strict();
export type UsageEventInput = z.infer<typeof UsageEventInput>;

export const InvoiceStatus = z.enum(["DRAFT", "ISSUED", "PAID", "OVERDUE", "VOID", "RED_FLUSH"]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const InvoiceLineItem = z
  .object({
    description: z.string().min(1).max(255),
    quantity: z.number().nonnegative(),
    unitPriceCents: z.number().int().nonnegative(),
    amountCents: z.number().int().nonnegative(),
  })
  .strict();
export type InvoiceLineItem = z.infer<typeof InvoiceLineItem>;

export const Invoice = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    tenantName: z.string(),
    number: z.string().min(1),
    status: InvoiceStatus,
    periodStart: Timestamp,
    periodEnd: Timestamp,
    dueAt: Timestamp.nullable(),
    issuedAt: Timestamp.nullable(),
    paidAt: Timestamp.nullable(),
    subtotalCents: z.number().int().nonnegative(),
    taxRateBp: z.number().int().nonnegative(),
    taxCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(),
    currency: Currency,
    lineItems: z.array(InvoiceLineItem),
    notes: z.string().nullable(),
    createdBy: z.string(),
    approvedBy: z.string().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type Invoice = z.infer<typeof Invoice>;

export const RefundStatus = z.enum(["REQUESTED", "APPROVED", "REJECTED"]);
export type RefundStatus = z.infer<typeof RefundStatus>;

export const Refund = z
  .object({
    id: EntityId,
    invoiceId: EntityId,
    tenantId: EntityId,
    amountCents: z.number().int().positive(),
    reason: z.string().min(1).max(500),
    status: RefundStatus,
    requestedBy: z.string(),
    approvedBy: z.string().nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type Refund = z.infer<typeof Refund>;

export const TaxProfile = z
  .object({
    tenantId: EntityId,
    title: z.string().min(1).max(255),
    taxNo: z.string().max(64).nullable(),
    bank: z.string().max(255).nullable(),
    address: z.string().max(255).nullable(),
    invoiceType: z.enum(["VAT_SPECIAL", "VAT_NORMAL", "E_INVOICE", "NONE"]),
    taxRateBp: z.number().int().nonnegative(),
  })
  .strict();
export type TaxProfile = z.infer<typeof TaxProfile>;

export const InvoiceSettings = z
  .object({
    invoiceType: z.enum(["VAT_SPECIAL", "VAT_NORMAL", "E_INVOICE"]),
    /** 6% = 600 bp；13% = 1300 bp。 */
    taxRateBp: z.number().int().min(0).max(10000),
    priceDisplay: z.enum(["TAX_EXCLUSIVE", "TAX_INCLUSIVE"]),
    issuerEntity: z.string().min(1).max(255),
    issueTiming: z.enum(["AFTER_PAYMENT_3D", "AFTER_PAYMENT", "BEFORE_PAYMENT"]),
    redFlushRule: z.enum(["FINANCE_REVIEW", "OWNER_REVIEW"]),
    version: z.number().int().positive(),
    updatedBy: z.string().nullable(),
    updatedAt: Timestamp,
  })
  .strict();
export type InvoiceSettings = z.infer<typeof InvoiceSettings>;

/** 平台审计：只追加，不可改。与租户审计完全分开。 */
export const PlatformAuditEntry = z
  .object({
    id: EntityId,
    actorSub: z.string(),
    actorName: z.string(),
    actorRole: PlatformRole,
    action: z.string().min(1),
    targetType: z.string().min(1),
    targetId: z.string().nullable(),
    before: JsonValueSchema.nullable(),
    after: JsonValueSchema.nullable(),
    reason: z.string().nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type PlatformAuditEntry = z.infer<typeof PlatformAuditEntry>;

export const ApprovalAction = z.enum([
  "TENANT_PURGE",
  "TENANT_FORCE_PLAN",
  "PRICE_CHANGE",
  "TAX_CHANGE",
  "INVOICE_VOID",
  "REFUND",
  "BREAK_GLASS",
]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;

export const ApprovalStatus = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "EXECUTED"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalVote = z
  .object({
    subject: z.string(),
    name: z.string(),
    role: PlatformRole,
    at: Timestamp,
  })
  .strict();
export type ApprovalVote = z.infer<typeof ApprovalVote>;

export const ApprovalRequest = z
  .object({
    id: EntityId,
    action: ApprovalAction,
    targetType: z.string(),
    targetId: z.string().nullable(),
    summary: z.string().min(1),
    payload: z.record(JsonValueSchema),
    requiredRoles: z.array(PlatformRole).min(1),
    votes: z.array(ApprovalVote),
    status: ApprovalStatus,
    requestedBy: z.string(),
    requestedByName: z.string(),
    reason: z.string().min(1),
    expiresAt: Timestamp,
    decidedAt: Timestamp.nullable(),
    result: z.record(JsonValueSchema).nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const BreakGlassStatus = z.enum(["PENDING", "APPROVED", "ACTIVE", "EXPIRED", "REJECTED"]);
export type BreakGlassStatus = z.infer<typeof BreakGlassStatus>;

export const BreakGlassRequest = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    tenantName: z.string(),
    ticketNo: z.string().min(1).max(64),
    reason: z.string().min(1).max(1000),
    status: BreakGlassStatus,
    tenantConsent: z.boolean(),
    consentAt: Timestamp.nullable(),
    requestedBy: z.string(),
    approvedBy: z.string().nullable(),
    startsAt: Timestamp.nullable(),
    expiresAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type BreakGlassRequest = z.infer<typeof BreakGlassRequest>;

export const FeatureFlag = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    description: z.string().max(500),
    enabled: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    tenantIds: z.array(EntityId),
    updatedBy: z.string().nullable(),
    updatedAt: Timestamp,
  })
  .strict();
export type FeatureFlag = z.infer<typeof FeatureFlag>;

export const ConfigScope = z.enum(["GLOBAL", "PLAN", "TENANT"]);
export type ConfigScope = z.infer<typeof ConfigScope>;

export const PlatformConfig = z
  .object({
    id: EntityId,
    key: z.string().min(1).max(128),
    scope: ConfigScope,
    scopeRef: z.string().nullable(),
    value: JsonValueSchema,
    version: z.number().int().positive(),
    status: z.enum(["ACTIVE", "SUPERSEDED"]),
    effectiveFrom: Timestamp,
    createdBy: z.string(),
    createdAt: Timestamp,
  })
  .strict();
export type PlatformConfig = z.infer<typeof PlatformConfig>;

export const PlatformLlmScope = z.enum(["GLOBAL", "TENANT"]);
export type PlatformLlmScope = z.infer<typeof PlatformLlmScope>;

export const PlatformLlmSettings = z
  .object({
    scope: PlatformLlmScope,
    tenantId: EntityId.nullable(),
    provider: z.string().min(1).max(64),
    baseUrl: z.string().url().nullable(),
    defaultModel: z.string().min(1).max(128),
    dailyTokenBudget: z.number().int().nonnegative().nullable(),
    monthlyTokenBudget: z.number().int().nonnegative().nullable(),
    keyRef: z.string().max(255).nullable(),
    allowExternal: z.boolean(),
    version: z.number().int().positive(),
    updatedBy: z.string().nullable(),
    updatedAt: Timestamp,
  })
  .strict();
export type PlatformLlmSettings = z.infer<typeof PlatformLlmSettings>;

export const PlatformIdentitySettings = z
  .object({
    mfaRequired: z.boolean(),
    socialLoginAllowed: z.boolean(),
    ssoEnabled: z.boolean(),
    casdoorOrgTemplate: z.string().min(1).max(128),
    sessionMaxHours: z.number().int().positive(),
    updatedBy: z.string().nullable(),
    updatedAt: Timestamp,
  })
  .strict();
export type PlatformIdentitySettings = z.infer<typeof PlatformIdentitySettings>;

export const TicketStatus = z.enum(["OPEN", "PENDING", "RESOLVED"]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const SupportTicket = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    tenantName: z.string(),
    title: z.string().min(1).max(255),
    body: z.string().min(1).max(4000),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
    status: TicketStatus,
    createdBy: z.string(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type SupportTicket = z.infer<typeof SupportTicket>;

/** 租户列表项：只含账号级信息，绝不含业务数据。 */
export const TenantSummary = z
  .object({
    id: EntityId,
    slug: z.string(),
    name: z.string(),
    status: PlatformTenantStatus,
    isolationMode: IsolationMode,
    region: z.string(),
    currency: Currency,
    healthScore: z.number().int().min(0).max(100),
    planCode: z.string().nullable(),
    seats: z.number().int().nonnegative(),
    billingCycle: BillingCycle.nullable(),
    effectiveMonthlyCents: z.number().int().nonnegative(),
    agentActionsUsed: z.number().int().nonnegative(),
    agentActionsQuota: z.number().int().nonnegative(),
    nextDueAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type TenantSummary = z.infer<typeof TenantSummary>;

export const TenantDetail = z
  .object({
    tenant: TenantSummary,
    subscription: Subscription.nullable(),
    plan: Plan.nullable(),
    usage: z.array(UsageDay),
    overrides: z.array(TenantPriceOverride),
    taxProfile: TaxProfile.nullable(),
    llmOverride: PlatformLlmSettings.nullable(),
    featureFlags: z.array(z.string()),
    notes: z.string().nullable(),
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable(),
  })
  .strict();
export type TenantDetail = z.infer<typeof TenantDetail>;

export const Overview = z
  .object({
    mrrCents: z.number().int().nonnegative(),
    arrCents: z.number().int().nonnegative(),
    activeTenants: z.number().int().nonnegative(),
    trialTenants: z.number().int().nonnegative(),
    trialConversionRate: z.number().min(0).max(1),
    churnedLast30d: z.number().int().nonnegative(),
    grossMarginBps: z.number().int(),
    llmCostCentsThisMonth: z.number().int().nonnegative(),
    revenueCentsThisMonth: z.number().int().nonnegative(),
    openIncidents: z.number().int().nonnegative(),
    overdueInvoices: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    trialFunnel: z.array(z.object({ stage: z.string(), count: z.number().int() }).strict()),
  })
  .strict();
export type Overview = z.infer<typeof Overview>;

export const UsageOverview = z
  .object({
    period: z.string(),
    totalAgentActions: z.number().int().nonnegative(),
    totalStorageGb: z.number().nonnegative(),
    totalSms: z.number().int().nonnegative(),
    totalLlmTokens: z.number().int().nonnegative(),
    totalLlmCostCents: z.number().int().nonnegative(),
    topConsumers: z.array(
      z
        .object({
          tenantId: EntityId,
          tenantName: z.string(),
          agentActions: z.number().int().nonnegative(),
          storageGb: z.number().nonnegative(),
          llmCostCents: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    anomalies: z.array(
      z
        .object({
          tenantId: EntityId,
          tenantName: z.string(),
          metric: z.string(),
          message: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type UsageOverview = z.infer<typeof UsageOverview>;

/* ------------------------------- 写入契约 ------------------------------- */

export const ProvisionTenantInput = z
  .object({
    name: z.string().min(1).max(255),
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    contactName: z.string().max(255).optional(),
    contactEmail: z.string().email().optional(),
    planCode: z.string().min(1),
    seats: z.number().int().positive().max(10000),
    billingCycle: BillingCycle.default("MONTHLY"),
    isolationMode: IsolationMode.default("SHARED_RLS"),
    region: z.string().min(1).max(32).default("cn-east"),
    trialDays: z.number().int().min(0).max(90).default(3),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type ProvisionTenantInput = z.infer<typeof ProvisionTenantInput>;

export const ChangeSubscriptionInput = z
  .object({
    planCode: z.string().min(1),
    seats: z.number().int().positive().max(10000),
    billingCycle: BillingCycle,
    /** 强制定价（绕开标准价）必须走双人复核，返回 approval 而非直接生效。 */
    forceMonthlyPriceCents: z.number().int().nonnegative().optional(),
    forceReason: z.string().max(500).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type ChangeSubscriptionInput = z.infer<typeof ChangeSubscriptionInput>;

export const TenantStatusInput = z
  .object({
    status: z.enum(["ACTIVE", "OVERDUE", "SUSPENDED", "CANCELLED"]),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type TenantStatusInput = z.infer<typeof TenantStatusInput>;

export const CreateInvoiceInput = z
  .object({
    tenantId: EntityId,
    periodStart: Timestamp,
    periodEnd: Timestamp,
    notes: z.string().max(1000).optional(),
    /** 手工调整行（正负均可），金额由服务端重算。 */
    adjustments: z
      .array(
        z
          .object({
            description: z.string().min(1).max(255),
            amountCents: z.number().int(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type CreateInvoiceInput = z.infer<typeof CreateInvoiceInput>;

export const InvoiceActionInput = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();
export type InvoiceActionInput = z.infer<typeof InvoiceActionInput>;

export const IssueInvoiceInput = z
  .object({
    dueAt: Timestamp.optional(),
  })
  .strict();
export type IssueInvoiceInput = z.infer<typeof IssueInvoiceInput>;

export const PriceBookInput = z
  .object({
    notes: z.string().max(1000).optional(),
    prices: z
      .array(
        z
          .object({
            planCode: z.string().min(1),
            monthlyPriceCents: z.number().int().nonnegative(),
            annualPriceCents: z.number().int().nonnegative(),
            currency: Currency.default("CNY"),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PriceBookInput = z.infer<typeof PriceBookInput>;

export const PriceOverrideInput = z
  .object({
    planCode: z.string().min(1),
    monthlyPriceCents: z.number().int().nonnegative(),
    seats: z.number().int().positive().nullable().optional(),
    effectiveFrom: Timestamp,
    effectiveTo: Timestamp.nullable().optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type PriceOverrideInput = z.infer<typeof PriceOverrideInput>;

export const InvoiceSettingsInput = z
  .object({
    invoiceType: InvoiceSettings.shape.invoiceType.optional(),
    taxRateBp: InvoiceSettings.shape.taxRateBp.optional(),
    priceDisplay: InvoiceSettings.shape.priceDisplay.optional(),
    issuerEntity: InvoiceSettings.shape.issuerEntity.optional(),
    issueTiming: InvoiceSettings.shape.issueTiming.optional(),
    redFlushRule: InvoiceSettings.shape.redFlushRule.optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type InvoiceSettingsInput = z.infer<typeof InvoiceSettingsInput>;

export const RefundInput = z
  .object({
    amountCents: z.number().int().positive(),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type RefundInput = z.infer<typeof RefundInput>;

export const TaxProfileInput = TaxProfile.omit({ tenantId: true }).extend({
  tenantId: EntityId,
});
export type TaxProfileInput = z.infer<typeof TaxProfileInput>;

export const PlatformApprovalDecisionInput = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type PlatformApprovalDecisionInput = z.infer<typeof PlatformApprovalDecisionInput>;

export const CreateApprovalInput = z
  .object({
    action: ApprovalAction,
    targetType: z.string().min(1).max(64),
    targetId: z.string().max(128).nullable().optional(),
    summary: z.string().min(1).max(255),
    payload: z.record(JsonValueSchema),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type CreateApprovalInput = z.infer<typeof CreateApprovalInput>;

export const BreakGlassInput = z
  .object({
    tenantId: EntityId,
    ticketNo: z.string().min(1).max(64),
    reason: z.string().min(1).max(1000),
    /** 租户管理员已在应用内/工单中明确同意。 */
    tenantConsent: z.boolean(),
  })
  .strict();
export type BreakGlassInput = z.infer<typeof BreakGlassInput>;

export const FeatureFlagInput = z
  .object({
    enabled: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    tenantIds: z.array(EntityId).optional(),
  })
  .strict();
export type FeatureFlagInput = z.infer<typeof FeatureFlagInput>;

export const PlatformConfigInput = z
  .object({
    key: z.string().min(1).max(128),
    scope: ConfigScope,
    scopeRef: z.string().max(128).nullable().optional(),
    value: JsonValueSchema,
  })
  .strict();
export type PlatformConfigInput = z.infer<typeof PlatformConfigInput>;

export const PlatformLlmSettingsInput = z
  .object({
    scope: PlatformLlmScope,
    tenantId: EntityId.nullable().optional(),
    provider: z.string().min(1).max(64).optional(),
    baseUrl: z.string().url().nullable().optional(),
    defaultModel: z.string().min(1).max(128).optional(),
    dailyTokenBudget: z.number().int().nonnegative().nullable().optional(),
    monthlyTokenBudget: z.number().int().nonnegative().nullable().optional(),
    keyRef: z.string().max(255).nullable().optional(),
    allowExternal: z.boolean().optional(),
  })
  .strict();
export type PlatformLlmSettingsInput = z.infer<typeof PlatformLlmSettingsInput>;

export const IdentitySettingsInput = z
  .object({
    mfaRequired: z.boolean().optional(),
    ssoEnabled: z.boolean().optional(),
    casdoorOrgTemplate: z.string().min(1).max(128).optional(),
    sessionMaxHours: z.number().int().positive().optional(),
  })
  .strict();
export type IdentitySettingsInput = z.infer<typeof IdentitySettingsInput>;

export const SupportTicketInput = z
  .object({
    tenantId: EntityId,
    title: z.string().min(1).max(255),
    body: z.string().min(1).max(4000),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  })
  .strict();
export type SupportTicketInput = z.infer<typeof SupportTicketInput>;

export const TicketStatusInput = z.object({ status: TicketStatus }).strict();
export type TicketStatusInput = z.infer<typeof TicketStatusInput>;

export const PricingPreviewInput = z
  .object({
    planCode: z.string().min(1),
    seats: z.number().int().positive(),
    billingCycle: BillingCycle,
    monthlyPriceCents: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PricingPreviewInput = z.infer<typeof PricingPreviewInput>;

export const PricingPreview = z
  .object({
    planCode: z.string(),
    seats: z.number().int(),
    billingCycle: BillingCycle,
    monthlyPriceCents: z.number().int(),
    monthlyTotalCents: z.number().int(),
    annualTotalCents: z.number().int(),
    effectiveMonthlyCents: z.number().int(),
  })
  .strict();
export type PricingPreview = z.infer<typeof PricingPreview>;
