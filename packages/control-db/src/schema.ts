import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";

/**
 * 控制面物理隔离：所有表住在独立的 `control` schema（生产可指向独立数据库）。
 * 这里**不允许**出现任何租户业务表（customers / quotes / samples / orders …）。
 * `apps/platform-api/test/isolation.test.ts` 会扫描源码与表清单守住这条线。
 */
export const control = pgSchema("control");

export const platformRoleEnum = control.enum("platform_role", [
  "platform_owner",
  "platform_finance",
  "platform_support",
  "platform_ops",
  "platform_readonly",
]);
export const platformUserStatusEnum = control.enum("platform_user_status", ["ACTIVE", "DISABLED"]);
export const platformTenantStatusEnum = control.enum("platform_tenant_status", [
  "TRIAL",
  "ACTIVE",
  "OVERDUE",
  "SUSPENDED",
  "CANCELLED",
]);
export const isolationModeEnum = control.enum("isolation_mode", [
  "SHARED_RLS",
  "SCHEMA",
  "DATABASE",
]);
export const billingCycleEnum = control.enum("billing_cycle", ["MONTHLY", "ANNUAL"]);
export const subscriptionStatusEnum = control.enum("subscription_status", [
  "TRIAL",
  "ACTIVE",
  "OVERDUE",
  "SUSPENDED",
  "CANCELLED",
]);
export const planStatusEnum = control.enum("plan_status", ["ACTIVE", "RETIRED"]);
export const priceBookStatusEnum = control.enum("price_book_status", [
  "DRAFT",
  "ACTIVE",
  "RETIRED",
]);
export const overrideStatusEnum = control.enum("override_status", [
  "PENDING",
  "ACTIVE",
  "EXPIRED",
  "REVOKED",
]);
export const usageKindEnum = control.enum("usage_kind", [
  "agent_action",
  "storage",
  "sms",
  "llm_tokens",
]);
export const invoiceStatusEnum = control.enum("invoice_status", [
  "DRAFT",
  "ISSUED",
  "PAID",
  "OVERDUE",
  "VOID",
  "RED_FLUSH",
]);
export const invoiceTypeEnum = control.enum("invoice_type", [
  "VAT_SPECIAL",
  "VAT_NORMAL",
  "E_INVOICE",
  "NONE",
]);
export const configScopeEnum = control.enum("config_scope", ["GLOBAL", "PLAN", "TENANT"]);
export const configStatusEnum = control.enum("config_status", ["ACTIVE", "SUPERSEDED"]);
export const llmScopeEnum = control.enum("llm_scope", ["GLOBAL", "TENANT"]);
export const approvalActionEnum = control.enum("approval_action", [
  "TENANT_PURGE",
  "TENANT_FORCE_PLAN",
  "PRICE_CHANGE",
  "TAX_CHANGE",
  "INVOICE_VOID",
  "REFUND",
  "BREAK_GLASS",
]);
export const approvalStatusEnum = control.enum("approval_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "EXECUTED",
]);
export const breakGlassStatusEnum = control.enum("break_glass_status", [
  "PENDING",
  "APPROVED",
  "ACTIVE",
  "EXPIRED",
  "REJECTED",
]);
export const ticketStatusEnum = control.enum("ticket_status", ["OPEN", "PENDING", "RESOLVED"]);

export const platformUsers = control.table(
  "platform_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subject: varchar("subject", { length: 128 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    role: platformRoleEnum("role").notNull(),
    status: platformUserStatusEnum("status").notNull().default("ACTIVE"),
    mfaEnforced: boolean("mfa_enforced").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("platform_users_subject_idx").on(table.subject)],
);

export const tenants = control.table(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    status: platformTenantStatusEnum("status").notNull().default("TRIAL"),
    isolationMode: isolationModeEnum("isolation_mode").notNull().default("SHARED_RLS"),
    region: varchar("region", { length: 32 }).notNull().default("cn-east"),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    healthScore: integer("health_score").notNull().default(80),
    notes: text("notes"),
    contactName: varchar("contact_name", { length: 255 }),
    contactEmail: varchar("contact_email", { length: 255 }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    churnedAt: timestamp("churned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("control_tenants_slug_idx").on(table.slug),
    index("control_tenants_status_idx").on(table.status),
  ],
);

export const plans = control.table("plans", {
  code: varchar("code", { length: 32 }).primaryKey(),
  name: varchar("name", { length: 64 }).notNull(),
  tier: integer("tier").notNull(),
  seatMin: integer("seat_min").notNull().default(1),
  seatMax: integer("seat_max"),
  agentActionsQuota: integer("agent_actions_quota").notNull().default(0),
  storageGb: integer("storage_gb").notNull().default(0),
  features: jsonb("features").$type<Record<string, boolean>>().notNull().default({}),
  status: planStatusEnum("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const priceBooks = control.table(
  "price_books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: integer("version").notNull(),
    status: priceBookStatusEnum("status").notNull().default("DRAFT"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("control_price_books_version_idx").on(table.version)],
);

export const planPrices = control.table(
  "plan_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    priceBookId: uuid("price_book_id")
      .notNull()
      .references(() => priceBooks.id, { onDelete: "cascade" }),
    planCode: varchar("plan_code", { length: 32 })
      .notNull()
      .references(() => plans.code),
    monthlyPriceCents: bigint("monthly_price_cents", { mode: "number" }).notNull(),
    annualPriceCents: bigint("annual_price_cents", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
  },
  (table) => [
    uniqueIndex("control_plan_prices_book_plan_idx").on(table.priceBookId, table.planCode),
  ],
);

export const tenantPriceOverrides = control.table(
  "tenant_price_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    planCode: varchar("plan_code", { length: 32 }).notNull(),
    monthlyPriceCents: bigint("monthly_price_cents", { mode: "number" }).notNull(),
    seats: integer("seats"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: overrideStatusEnum("status").notNull().default("PENDING"),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    approvedBy: varchar("approved_by", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("control_overrides_tenant_idx").on(table.tenantId, table.status)],
);

export const subscriptions = control.table(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    planCode: varchar("plan_code", { length: 32 })
      .notNull()
      .references(() => plans.code),
    priceBookId: uuid("price_book_id")
      .notNull()
      .references(() => priceBooks.id),
    seats: integer("seats").notNull(),
    billingCycle: billingCycleEnum("billing_cycle").notNull().default("MONTHLY"),
    status: subscriptionStatusEnum("status").notNull().default("TRIAL"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    effectiveMonthlyCents: bigint("effective_monthly_cents", { mode: "number" })
      .notNull()
      .default(0),
    overrideId: uuid("override_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("control_subscriptions_tenant_idx").on(table.tenantId)],
);

export const usageDaily = control.table(
  "usage_daily",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    agentActions: integer("agent_actions").notNull().default(0),
    storageGb: numeric("storage_gb", { precision: 12, scale: 3 }).notNull().default("0"),
    smsCount: integer("sms_count").notNull().default(0),
    llmInputTokens: bigint("llm_input_tokens", { mode: "number" }).notNull().default(0),
    llmOutputTokens: bigint("llm_output_tokens", { mode: "number" }).notNull().default(0),
    llmCostCents: bigint("llm_cost_cents", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("control_usage_daily_pk").on(table.tenantId, table.day),
    index("control_usage_daily_day_idx").on(table.day),
  ],
);

export const usageEvents = control.table(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: usageKindEnum("kind").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    meta: jsonb("meta").$type<JsonValue>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("control_usage_events_idempotency_idx").on(table.idempotencyKey),
    index("control_usage_events_tenant_idx").on(table.tenantId, table.occurredAt),
  ],
);

export const invoices = control.table(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    number: varchar("number", { length: 32 }).notNull(),
    status: invoiceStatusEnum("status").notNull().default("DRAFT"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull(),
    taxRateBp: integer("tax_rate_bp").notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    lineItems: jsonb("line_items").$type<unknown[]>().notNull().default([]),
    notes: text("notes"),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    approvedBy: varchar("approved_by", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("control_invoices_number_idx").on(table.number),
    index("control_invoices_tenant_idx").on(table.tenantId, table.status),
  ],
);

export const refundStatusEnum = control.enum("refund_status", [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
]);

export const refunds = control.table(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: refundStatusEnum("status").notNull().default("REQUESTED"),
    requestedBy: varchar("requested_by", { length: 128 }).notNull(),
    approvedBy: varchar("approved_by", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("control_refunds_invoice_idx").on(table.invoiceId)],
);

export const taxProfiles = control.table("tax_profiles", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  taxNo: varchar("tax_no", { length: 64 }),
  bank: varchar("bank", { length: 255 }),
  address: varchar("address", { length: 255 }),
  invoiceType: invoiceTypeEnum("invoice_type").notNull().default("VAT_SPECIAL"),
  taxRateBp: integer("tax_rate_bp").notNull().default(600),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invoiceSettings = control.table("invoice_settings", {
  id: varchar("id", { length: 16 }).primaryKey().default("default"),
  invoiceType: invoiceTypeEnum("invoice_type").notNull().default("VAT_SPECIAL"),
  taxRateBp: integer("tax_rate_bp").notNull().default(600),
  priceDisplay: varchar("price_display", { length: 32 }).notNull().default("TAX_EXCLUSIVE"),
  issuerEntity: varchar("issuer_entity", { length: 255 })
    .notNull()
    .default("织序（上海）科技有限公司"),
  issueTiming: varchar("issue_timing", { length: 32 }).notNull().default("AFTER_PAYMENT_3D"),
  redFlushRule: varchar("red_flush_rule", { length: 32 }).notNull().default("FINANCE_REVIEW"),
  version: integer("version").notNull().default(1),
  updatedBy: varchar("updated_by", { length: 128 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformAudit = control.table(
  "platform_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorSub: varchar("actor_sub", { length: 128 }).notNull(),
    actorName: varchar("actor_name", { length: 255 }).notNull(),
    actorRole: platformRoleEnum("actor_role").notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 64 }).notNull(),
    targetId: varchar("target_id", { length: 128 }),
    before: jsonb("before").$type<JsonValue | null>(),
    after: jsonb("after").$type<JsonValue | null>(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("control_platform_audit_created_idx").on(table.createdAt)],
);

export const approvals = control.table(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: approvalActionEnum("action").notNull(),
    targetType: varchar("target_type", { length: 64 }).notNull(),
    targetId: varchar("target_id", { length: 128 }),
    summary: varchar("summary", { length: 255 }).notNull(),
    payload: jsonb("payload").$type<Record<string, JsonValue>>().notNull(),
    requiredRoles: jsonb("required_roles").$type<string[]>().notNull(),
    votes: jsonb("votes").$type<unknown[]>().notNull().default([]),
    status: approvalStatusEnum("status").notNull().default("PENDING"),
    requestedBy: varchar("requested_by", { length: 128 }).notNull(),
    requestedByName: varchar("requested_by_name", { length: 255 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, JsonValue> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("control_approvals_status_idx").on(table.status, table.expiresAt)],
);

export const breakGlassRequests = control.table(
  "break_glass_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ticketNo: varchar("ticket_no", { length: 64 }).notNull(),
    reason: text("reason").notNull(),
    status: breakGlassStatusEnum("status").notNull().default("PENDING"),
    tenantConsent: boolean("tenant_consent").notNull().default(false),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    requestedBy: varchar("requested_by", { length: 128 }).notNull(),
    approvedBy: varchar("approved_by", { length: 128 }),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("control_break_glass_status_idx").on(table.status)],
);

export const featureFlags = control.table("feature_flags", {
  key: varchar("key", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  description: varchar("description", { length: 500 }).notNull().default(""),
  enabled: boolean("enabled").notNull().default(false),
  rolloutPercent: integer("rollout_percent").notNull().default(0),
  tenantIds: jsonb("tenant_ids").$type<string[]>().notNull().default([]),
  updatedBy: varchar("updated_by", { length: 128 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformConfigs = control.table(
  "platform_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 128 }).notNull(),
    scope: configScopeEnum("scope").notNull(),
    scopeRef: varchar("scope_ref", { length: 128 }),
    value: jsonb("value").$type<JsonValue>().notNull(),
    version: integer("version").notNull(),
    status: configStatusEnum("status").notNull().default("ACTIVE"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("control_platform_configs_key_idx").on(table.key, table.scope, table.scopeRef),
    uniqueIndex("control_platform_configs_version_idx").on(
      table.key,
      table.scope,
      sql`coalesce(${table.scopeRef}, '')`,
      table.version,
    ),
  ],
);

export const llmSettings = control.table(
  "llm_settings",
  {
    scope: llmScopeEnum("scope").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 64 }).notNull().default("openai-compatible"),
    baseUrl: varchar("base_url", { length: 512 }),
    defaultModel: varchar("default_model", { length: 128 }).notNull(),
    dailyTokenBudget: bigint("daily_token_budget", { mode: "number" }),
    monthlyTokenBudget: bigint("monthly_token_budget", { mode: "number" }),
    keyRef: varchar("key_ref", { length: 255 }).default("LLM_API_KEY"),
    allowExternal: boolean("allow_external").notNull().default(true),
    version: integer("version").notNull().default(1),
    updatedBy: varchar("updated_by", { length: 128 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("control_llm_settings_global_idx")
      .on(table.scope)
      .where(sql`${table.scope} = 'GLOBAL'`),
    uniqueIndex("control_llm_settings_tenant_idx")
      .on(table.tenantId)
      .where(sql`${table.scope} = 'TENANT'`),
  ],
);

export const identitySettings = control.table("identity_settings", {
  id: varchar("id", { length: 16 }).primaryKey().default("default"),
  mfaRequired: boolean("mfa_required").notNull().default(true),
  socialLoginAllowed: boolean("social_login_allowed").notNull().default(false),
  ssoEnabled: boolean("sso_enabled").notNull().default(false),
  casdoorOrgTemplate: varchar("casdoor_org_template", { length: 128 })
    .notNull()
    .default("weave-{slug}"),
  sessionMaxHours: integer("session_max_hours").notNull().default(8),
  updatedBy: varchar("updated_by", { length: 128 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportTickets = control.table(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    priority: varchar("priority", { length: 16 }).notNull().default("NORMAL"),
    status: ticketStatusEnum("status").notNull().default("OPEN"),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("control_support_tickets_status_idx").on(table.status)],
);

/** 发票号序列（控制面独立，绝不与租户业务编号共用）。 */
export const invoiceNumberSeq = control.sequence("invoice_number_seq", { startWith: 1000 });

export type PlatformUserRow = typeof platformUsers.$inferSelect;
export type TenantRow = typeof tenants.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type PriceBookRow = typeof priceBooks.$inferSelect;
export type PlanPriceRow = typeof planPrices.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type UsageDayRow = typeof usageDaily.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type BreakGlassRow = typeof breakGlassRequests.$inferSelect;
export type FeatureFlagRow = typeof featureFlags.$inferSelect;
export type PlatformConfigRow = typeof platformConfigs.$inferSelect;
export type LlmSettingsRow = typeof llmSettings.$inferSelect;
export type TicketRow = typeof supportTickets.$inferSelect;
export type RefundRow = typeof refunds.$inferSelect;
export type TaxProfileRow = typeof taxProfiles.$inferSelect;
export type InvoiceSettingsRow = typeof invoiceSettings.$inferSelect;
export type IdentitySettingsRow = typeof identitySettings.$inferSelect;
export type AuditRow = typeof platformAudit.$inferSelect;
export type OverrideRow = typeof tenantPriceOverrides.$inferSelect;
