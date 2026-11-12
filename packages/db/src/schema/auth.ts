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

/**
 * 用户侧凭据（WAN-78）：账号、个人 API token、CLI 设备登录授权。
 *
 * 安全约束：
 * - `api_tokens` 只存 SHA-256 哈希与可展示前缀，明文 token 不落库；
 * - `device_authorizations` 只存 device_code 的哈希，user_code 一次性使用；
 * - 所有 token 都属于某个 `users` 行，撤销 = 写 `revoked_at`，永不物理删除（留痕可审计）。
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

/**
 * 账号。MVP 以邮箱唯一标识；接入 Casdoor 后新增 `idp_subject` 映射即可，
 * 不改动 token 表结构。
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)],
);

/** 个人 API token。 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    index("api_tokens_user_id_idx").on(table.userId),
  ],
);

/**
 * CLI 设备登录授权（RFC 8628 思路）。
 *
 * CLI 用 `device_code` 轮询；人类在浏览器输入 `user_code` 确认，
 * 确认后 CLI 一次性换到明文 token。任何一端的凭据都不经过对方。
 */
export const deviceAuthorizations = pgTable(
  "device_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceCodeHash: varchar("device_code_hash", { length: 64 }).notNull(),
    userCode: varchar("user_code", { length: 16 }).notNull(),
    clientName: varchar("client_name", { length: 64 }),
    status: deviceAuthStatusEnum("status").notNull().default("PENDING"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
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
