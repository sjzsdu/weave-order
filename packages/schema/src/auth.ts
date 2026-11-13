import { z } from "zod";
import { EntityId, Timestamp } from "./domain";
import { Membership, Tenant } from "./tenancy";

/**
 * 个人访问凭据（personal access token，PAT）：CLI / agent 的长期凭据。
 *
 * 与网关的 Casdoor OIDC 令牌互补：
 * - OIDC 令牌有 15 分钟寿命、只存在浏览器 httpOnly Cookie，适合人；
 * - PAT 有明确作用域与可撤销生命周期，适合 codex 等非交互 agent。
 *
 * 安全约束：
 * 1. 明文只返回一次；库里只存 `sha256(pepper + token)` 与可展示前缀。
 * 2. 凭据绑定到一条 `membership`（租户 + 角色），认证后仍走同一套
 *    membership → tenant 作用域 → RLS，不另开权限旁路。
 * 3. 作用域：read / write / approve。默认只发 read + write；approve 必须
 *    人类显式授予，避免 agent 用登录凭据自己批准自己。
 * 4. CLI 登录用设备码（RFC 8628 思路）：`/cli-login` 页面由已登录的人确认，
 *    浏览器里的 OIDC 会话决定凭据归属，CLI 只拿到一次性凭据。
 */
export const TokenScope = z.enum(["read", "write", "approve"]);
export type TokenScope = z.infer<typeof TokenScope>;

export const TOKEN_SCOPES: readonly TokenScope[] = ["read", "write", "approve"];

/** 默认作用域：登录即得到的「干活但不能审批」的凭据。 */
export const DEFAULT_TOKEN_SCOPES: readonly TokenScope[] = ["read", "write"];

export const ApiTokenStatus = z.enum(["ACTIVE", "REVOKED", "EXPIRED"]);
export type ApiTokenStatus = z.infer<typeof ApiTokenStatus>;

/** 凭据只读视图：永远不含明文与哈希。 */
export const ApiToken = z
  .object({
    id: EntityId,
    name: z.string().min(1).max(64),
    /** 可展示前缀，如 `wo_ab12cd34`。 */
    prefix: z.string().min(1).max(32),
    scopes: z.array(TokenScope).min(1),
    status: ApiTokenStatus,
    createdAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
    expiresAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
  })
  .strict();
export type ApiToken = z.infer<typeof ApiToken>;

export const CreateApiTokenInput = z
  .object({
    name: z.string().trim().min(1).max(64),
    scopes: z
      .array(TokenScope)
      .min(1)
      .max(TOKEN_SCOPES.length)
      .default([...DEFAULT_TOKEN_SCOPES]),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
export type CreateApiTokenInput = z.infer<typeof CreateApiTokenInput>;

/** 创建结果：明文 `token` 只出现这一次。 */
export const CreatedApiToken = z
  .object({
    token: z.string().min(1),
    tokenView: ApiToken,
  })
  .strict();
export type CreatedApiToken = z.infer<typeof CreatedApiToken>;

export const ApiTokenList = z.object({ tokens: z.array(ApiToken) }).strict();
export type ApiTokenList = z.infer<typeof ApiTokenList>;

/** `GET /api/auth/whoami`：CLI 自述，含租户与成员身份。 */
export const PersonalAccessIdentity = z
  .object({
    subject: z.string().min(1).max(128),
    tenant: Tenant,
    membership: Membership,
    token: ApiToken.nullable(),
  })
  .strict();
export type PersonalAccessIdentity = z.infer<typeof PersonalAccessIdentity>;

/** 设备登录：CLI 发起。 */
export const DeviceAuthorizationStartInput = z
  .object({
    /** 便于用户识别来源，如 `weave-cli/0.1.0`。 */
    clientName: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type DeviceAuthorizationStartInput = z.infer<typeof DeviceAuthorizationStartInput>;

export const DeviceAuthorizationStart = z
  .object({
    deviceCode: z.string().min(16),
    userCode: z.string().min(4),
    /** 人类打开的确认页，如 `http://localhost:5174/cli-login`。 */
    verificationUri: z.string().url(),
    verificationUriComplete: z.string().url(),
    expiresIn: z.number().int().positive(),
    interval: z.number().int().positive(),
  })
  .strict();
export type DeviceAuthorizationStart = z.infer<typeof DeviceAuthorizationStart>;

/**
 * 确认页的决定。身份来自浏览器会话（OIDC），不再由表单自报邮箱；
 * `scopes` 由页面上的勾选项决定，approve 默认不勾。
 */
export const DeviceAuthorizationDecision = z
  .object({
    userCode: z.string().trim().min(1).max(16),
    approve: z.boolean().default(true),
    scopes: z
      .array(TokenScope)
      .min(1)
      .max(TOKEN_SCOPES.length)
      .default([...DEFAULT_TOKEN_SCOPES]),
  })
  .strict();
export type DeviceAuthorizationDecision = z.infer<typeof DeviceAuthorizationDecision>;

export const DeviceAuthorizationDecisionResult = z
  .object({
    userCode: z.string(),
    approved: z.boolean(),
    subject: z.string(),
  })
  .strict();
export type DeviceAuthorizationDecisionResult = z.infer<typeof DeviceAuthorizationDecisionResult>;

export const DeviceAuthorizationPollInput = z.object({ deviceCode: z.string().min(16) }).strict();
export type DeviceAuthorizationPollInput = z.infer<typeof DeviceAuthorizationPollInput>;

/**
 * 轮询结果。`status` 是判别键：
 * pending / slow_down / approved（一次性返回明文）/ denied / expired。
 */
export const DeviceAuthorizationPollResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("slow_down"), interval: z.number().int().positive() }).strict(),
  z
    .object({
      status: z.literal("approved"),
      token: z.string().min(1),
      tokenView: ApiToken,
      membership: Membership,
      tenant: Tenant,
    })
    .strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
]);
export type DeviceAuthorizationPollResult = z.infer<typeof DeviceAuthorizationPollResult>;

/** 凭据错误码：HTTP 层与 CLI 共用的封闭集合。 */
export const AuthErrorCode = z.enum([
  "AUTH_REQUIRED",
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "SCOPE_REQUIRED",
  "INVALID_USER_CODE",
  "USER_CODE_EXPIRED",
  "DEVICE_CODE_INVALID",
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCode>;
