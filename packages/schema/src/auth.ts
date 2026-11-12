import { z } from "zod";
import { EntityId, Timestamp } from "./domain";

/**
 * 用户侧凭据契约：个人 API token + CLI 设备登录。
 *
 * 设计约束（与产品铁律一致）：
 * 1. 明文 token 只在创建那一刻返回一次，数据库只存 SHA-256 哈希与可展示前缀。
 * 2. 作用域是封闭集合：read（读目录/全景/审计）、write（调用工具产出草稿）、
 *    approve（人类审批）。默认只给 read + write，approve 必须显式授予，
 *    避免「智能体拿着登录 token 自己批准自己」。
 * 3. CLI 登录走设备码流程（RFC 8628 思路）：CLI 拿 device_code 轮询，
 *    人类在浏览器确认，凭据不经过命令行回显，也不需要把密码交给第三方 agent。
 */

/** token 作用域：读 / 写（工具、草稿、导入）/ 审批（人类决策入口）。 */
export const TokenScope = z.enum(["read", "write", "approve"]);
export type TokenScope = z.infer<typeof TokenScope>;

export const TOKEN_SCOPES: readonly TokenScope[] = ["read", "write", "approve"];

/** 默认作用域：登录即得到的「干活但不能审批」的凭据。 */
export const DEFAULT_TOKEN_SCOPES: readonly TokenScope[] = ["read", "write"];

/** 账号（MVP：邮箱唯一；接入 Casdoor 后由 OIDC sub 映射，邮箱仍是展示字段）。 */
export const WeaveUser = z
  .object({
    id: EntityId,
    email: z.string().email().max(255),
    name: z.string().min(1).max(120),
    createdAt: Timestamp,
  })
  .strict();
export type WeaveUser = z.infer<typeof WeaveUser>;

/** token 的状态由服务端派生，不允许调用方写入。 */
export const ApiTokenStatus = z.enum(["ACTIVE", "REVOKED", "EXPIRED"]);
export type ApiTokenStatus = z.infer<typeof ApiTokenStatus>;

/** token 的只读视图：永远不含明文与哈希。 */
export const ApiToken = z
  .object({
    id: EntityId,
    name: z.string().min(1).max(64),
    /** 可展示前缀，如 `wo_ab12cd34`；用于让用户分辨是哪个 token。 */
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

/** 创建 token（已登录用户 / 设备登录确认时由服务端内部调用）。 */
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

/** 当前凭据自述：`weave whoami` / `GET /api/auth/me`。 */
export const AuthIdentity = z
  .object({
    user: WeaveUser,
    token: ApiToken,
  })
  .strict();
export type AuthIdentity = z.infer<typeof AuthIdentity>;

/** 设备登录：CLI 发起。 */
export const DeviceAuthorizationStartInput = z
  .object({
    /** 便于用户在「已授权的 CLI」列表里识别来源，如 `codex-cli/0.52.0`。 */
    clientName: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type DeviceAuthorizationStartInput = z.infer<typeof DeviceAuthorizationStartInput>;

export const DeviceAuthorizationStart = z
  .object({
    deviceCode: z.string().min(16),
    userCode: z.string().min(4),
    /** 人类打开的确认页，如 `http://localhost:3000/cli-login`。 */
    verificationUri: z.string().url(),
    /** 已带 user_code 的完整链接，CLI 直接拉起浏览器。 */
    verificationUriComplete: z.string().url(),
    expiresIn: z.number().int().positive(),
    interval: z.number().int().positive(),
  })
  .strict();
export type DeviceAuthorizationStart = z.infer<typeof DeviceAuthorizationStart>;

/**
 * 人类在确认页上的决定。MVP 用邮箱自证（无密码），
 * 接入 Casdoor 后这里改为 OIDC 会话，入参不再需要 email。
 */
export const DeviceAuthorizationDecision = z
  .object({
    userCode: z.string().trim().min(1).max(16),
    email: z.string().email().max(255),
    name: z.string().trim().min(1).max(120).optional(),
    approve: z.boolean().default(true),
    /** 是否允许这台 CLI 审批。默认关闭，人类可显式勾选。 */
    scopes: z
      .array(TokenScope)
      .min(1)
      .max(TOKEN_SCOPES.length)
      .default([...DEFAULT_TOKEN_SCOPES]),
    tokenName: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type DeviceAuthorizationDecision = z.infer<typeof DeviceAuthorizationDecision>;

export const DeviceAuthorizationDecisionResult = z
  .object({
    userCode: z.string(),
    approved: z.boolean(),
    email: z.string().email(),
  })
  .strict();
export type DeviceAuthorizationDecisionResult = z.infer<typeof DeviceAuthorizationDecisionResult>;

/** CLI 轮询凭证。 */
export const DeviceAuthorizationPollInput = z.object({ deviceCode: z.string().min(16) }).strict();
export type DeviceAuthorizationPollInput = z.infer<typeof DeviceAuthorizationPollInput>;

/**
 * 轮询结果。`status` 是判别键：
 * - pending：人类还没确认（CLI 继续等）
 * - slow_down：轮询过快（CLI 拉长间隔）
 * - approved：一次性返回明文 token
 * - denied / expired：终态，CLI 应提示重新登录
 */
export const DeviceAuthorizationPollResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("slow_down"), interval: z.number().int().positive() }).strict(),
  z
    .object({
      status: z.literal("approved"),
      token: z.string().min(1),
      tokenView: ApiToken,
      user: WeaveUser,
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
