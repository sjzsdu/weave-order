import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { memberships } from "./tenants";

/**
 * 个人访问凭据（PAT）与 CLI 设备登录（WAN-78）。
 *
 * 这是控制面数据，不带 tenant_id：一条凭据绑定到 `memberships.id`，
 * 认证时由网关解析出 membership → tenant，业务请求仍然走 RLS 会话。
 *
 * 安全约束：
 * - `api_tokens` 只存 SHA-256 哈希与可展示前缀，明文 token 不落库；
 * - `device_authorizations` 只存 device_code 的哈希，user_code 一次性使用；
 * - 撤销 = 写 `revoked_at`，永不物理删除（留痕可审计）。
 */

/** token 作用域（与 packages/schema 的 TokenScope 一一对应）。 */
export const tokenScopeEnum = pgEnum("token_scope", ["read", "write", "approve"]);

/** 设备登录授权状态。 */
export const deviceAuthStatusEnum = pgEnum("device_auth_status", [
  "PENDING",
  "APPROVED",
  "CONSUMED",
  "DENIED",
]);

/** 个人 API token。 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    /** token 的公开部分，用于查找（`wo_<publicId>_<secret>`）。 */
    publicId: varchar("public_id", { length: 16 }).notNull(),
    /** `sha256(pepper + 明文 token)` 的十六进制；不可逆。 */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("api_tokens_public_id_idx").on(table.publicId),
    index("api_tokens_membership_id_idx").on(table.membershipId),
  ],
);

/**
 * CLI 设备登录授权（RFC 8628 思路）。
 *
 * CLI 用 `device_code` 轮询；已登录的人类在 `/cli-login` 页面确认，
 * 确认时记录 membership；CLI 一次性换到明文 token。
 */
export const deviceAuthorizations = pgTable(
  "device_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceCodeHash: varchar("device_code_hash", { length: 64 }).notNull(),
    userCode: varchar("user_code", { length: 16 }).notNull(),
    clientName: varchar("client_name", { length: 64 }),
    status: deviceAuthStatusEnum("status").notNull().default("PENDING"),
    membershipId: uuid("membership_id").references(() => memberships.id, {
      onDelete: "cascade",
    }),
    scopes: jsonb("scopes").$type<string[]>(),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("device_authorizations_device_code_idx").on(table.deviceCodeHash),
    uniqueIndex("device_authorizations_user_code_idx").on(table.userCode),
  ],
);
