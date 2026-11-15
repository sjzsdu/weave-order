import { z } from "zod";
import { Capability } from "./capabilities";
import { Currency, EntityId, JsonValueSchema, Timestamp } from "./domain";

/**
 * 多租户与身份契约（T0 冻结）。
 *
 * 铁律 G4：`tenant_id` 永远由网关注入，前端不传。
 * `(sub, org)` 只用于查本地 membership，租户归属以本地记录为准。
 */

/** 租户状态。SUSPENDED 时只读，不阻断导出。 */
export const TenantStatus = z.enum(["ACTIVE", "TRIAL", "SUSPENDED", "CLOSED"]);
export type TenantStatus = z.infer<typeof TenantStatus>;

/** P0 只有共享库 + RLS；企业版升级到 schema / 独立库。 */
export const IsolationMode = z.enum(["SHARED_RLS", "SCHEMA", "DATABASE"]);
export type IsolationMode = z.infer<typeof IsolationMode>;

/** 租户（控制面实体，业务表均以其 id 作为 tenant_id）。 */
export const Tenant = z
  .object({
    id: EntityId,
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(255),
    brand: z.string().max(255).nullable(),
    bank: JsonValueSchema.nullable(),
    currency: Currency,
    settings: JsonValueSchema,
    status: TenantStatus,
    isolationMode: IsolationMode,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type Tenant = z.infer<typeof Tenant>;

/** 角色：P0 六类，权限差异在 memberships 的 dataScope / approvalLimit 上。 */
export const MemberRole = z.enum([
  "OWNER",
  "MANAGER",
  "SALES",
  "MERCHANDISER",
  "SAMPLE_ADMIN",
  "FINANCE",
  "VIEWER",
]);
export type MemberRole = z.infer<typeof MemberRole>;

/** 数据范围：全公司 / 本组 / 本人。 */
export const DataScope = z.enum(["ALL", "TEAM", "OWN"]);
export type DataScope = z.infer<typeof DataScope>;

export const MembershipStatus = z.enum(["ACTIVE", "INVITED", "DISABLED"]);
export type MembershipStatus = z.infer<typeof MembershipStatus>;

/**
 * 本地成员映射。
 * `subject` 是 Casdoor 的 `sub`；`casdoorOrg` 是签发令牌里的组织，仅用于校验，
 * 真正的租户以 membership.tenantId 为准。
 */
export const Membership = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    subject: z.string().min(1).max(128),
    casdoorOrg: z.string().min(1).max(128).nullable(),
    role: MemberRole,
    dataScope: DataScope,
    teamId: EntityId.nullable(),
    /** 审批金额上限（整数分）；超过则需上级复核。 */
    approvalLimitAmount: z.number().int().nonnegative().nullable(),
    status: MembershipStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type Membership = z.infer<typeof Membership>;

/**
 * 创建租户（平台侧/首次开通；业务侧不可自助建租户）。
 *
 * `casdoorOrg` 可选：登录时成员身份按 Casdoor `sub` 解析，`casdoorOrg` 只在两边都
 * 有值时才用于一致性校验（见 `resolveMembership`）。因此开通一个租户**不必**
 * 先在 Casdoor 里建 Organization——单人单租户的常规开通留空即可；只有需要按公司
 * 做 SSO 策略、品牌或 MFA 时才建 Org 并填上。
 */
export const CreateTenantInput = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(255),
    casdoorOrg: z.string().min(1).max(128).nullable().optional(),
    currency: Currency.default("CNY"),
  })
  .strict();
export type CreateTenantInput = z.infer<typeof CreateTenantInput>;

/** 创建成员映射（管理员操作）。 */
export const CreateMembershipInput = z
  .object({
    tenantId: EntityId,
    subject: z.string().min(1).max(128),
    casdoorOrg: z.string().min(1).max(128).nullable().optional(),
    role: MemberRole,
    dataScope: DataScope.default("OWN"),
    teamId: EntityId.nullable().optional(),
    approvalLimitAmount: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type CreateMembershipInput = z.infer<typeof CreateMembershipInput>;

/** Casdoor ID Token 校验后我们使用的 claims 子集。 */
export const AuthClaims = z
  .object({
    sub: z.string().min(1).max(128),
    /** Casdoor 组织（OIDC `org` 或 `orgName` claim）。 */
    org: z.string().min(1).max(128).nullable(),
    name: z.string().max(255).nullable(),
    email: z.string().email().nullable(),
    issuer: z.string().min(1),
    audience: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type AuthClaims = z.infer<typeof AuthClaims>;

/** 网关注入的请求级租户上下文；工具层与内核只认这个结构。 */
export const RequestContext = z
  .object({
    tenantId: EntityId,
    membershipId: EntityId,
    subject: z.string().min(1).max(128),
    role: MemberRole,
    dataScope: DataScope,
    approvalLimitAmount: z.number().int().nonnegative().nullable(),
    actorType: z.enum(["HUMAN", "AGENT", "SYSTEM"]),
    actorId: z.string().min(1).max(128),
    correlationId: EntityId.optional(),
  })
  .strict();
export type RequestContext = z.infer<typeof RequestContext>;

/** `GET /api/auth/me` 的响应契约。 */
export const AuthContextResponse = z
  .object({
    subject: z.string().min(1).max(128),
    name: z.string().max(255).nullable(),
    email: z.string().email().nullable(),
    tenant: Tenant,
    membership: Membership,
    /**
     * 服务端按 `capabilities.ts` 算好的能力清单：前端只按它显隐，
     * 不再自己从 `membership.role` 推导，避免出现第二份角色规则。
     */
    capabilities: z.array(Capability),
  })
  .strict();
export type AuthContextResponse = z.infer<typeof AuthContextResponse>;

/**
 * 租户选择器条目：只暴露该 subject 自己的授权事实。
 *
 * 不返回成员数、客户数、其他成员姓名，也不返回内部设置，
 * 因为「一个账号能列出哪些租户」本身已经是敏感信息。
 * `available=false` 用于「可见不可进」：membership 被 DISABLED 或租户 CLOSED。
 */
export const TenantChoice = z
  .object({
    tenantId: EntityId,
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(255),
    brand: z.string().max(255).nullable(),
    /** 该 subject 在这个租户的角色；未启用的成员身份不给角色，避免暗示权限。 */
    role: MemberRole.nullable(),
    tenantStatus: TenantStatus,
    membershipStatus: MembershipStatus,
    /** 只有 ACTIVE membership 且租户未关闭时才可进入。 */
    available: z.boolean(),
  })
  .strict();
export type TenantChoice = z.infer<typeof TenantChoice>;

/**
 * 已认证但还没选租户时的响应（`/api/auth/me`、`/api/auth/tenants`）。
 * 判别键 `status` 让前端不必靠字段缺失来猜状态。
 */
export const TenantChoicesResponse = z
  .object({
    status: z.literal("MULTI_TENANT"),
    subject: z.string().min(1).max(128),
    name: z.string().max(255).nullable(),
    email: z.string().email().nullable(),
    tenants: z.array(TenantChoice).min(1),
  })
  .strict();
export type TenantChoicesResponse = z.infer<typeof TenantChoicesResponse>;

/**
 * `GET /api/auth/me` 的完整响应：已绑定租户（单租户自动进入或已选择）或待选择。
 * 两个分支互斥：`MULTI_TENANT` 带 `tenants`，绑定态带 `tenant` + `membership`。
 */
export const AuthMeResponse = z.union([TenantChoicesResponse, AuthContextResponse]);
export type AuthMeResponse = z.infer<typeof AuthMeResponse>;

/** 首次选择与运行中切换共用同一输入形状；租户 ID 只出现在这个请求体里。 */
export const SwitchTenantInput = z
  .object({
    tenantId: EntityId,
  })
  .strict();
export type SwitchTenantInput = z.infer<typeof SwitchTenantInput>;

/** 统一 HTTP 错误响应（所有端只解析这一种失败结构）。 */
export const ApiErrorResponse = z
  .object({
    error: z
      .object({
        code: z.enum([
          "UNAUTHENTICATED",
          "FORBIDDEN",
          /** 该账号没有任何 ACTIVE membership：前端渲染「未加入公司」页，而不是裸 403。 */
          "NO_MEMBERSHIP",
          /** 目标租户的 membership 已停用 / 租户已关闭：可解释的拒绝，不区分是否存在。 */
          "TENANT_UNAVAILABLE",
          /** 已认证但没有租户作用域（多租户账号还没选）：前端回选择页。 */
          "TENANT_REQUIRED",
          /** 凭据作用域不足（例如 PAT 尝试切换租户）。 */
          "SCOPE_REQUIRED",
          "NOT_FOUND",
          "INVALID_INPUT",
          "CONFLICT",
          "RATE_LIMITED",
          "INTERNAL",
        ]),
        message: z.string(),
        details: JsonValueSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponse>;
