import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import { quoteShareEventEnum } from "./enums";
import { quotes } from "./quotes";

/**
 * 报价分享：只存 token 哈希，明文只在创建时返回一次。
 * `tokenHash` 全局唯一，使无登录的公开路由可以只按哈希定位租户。
 */
export const quoteShares = pgTable(
  "quote_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    requirePhoneTail: boolean("require_phone_tail").notNull().default(false),
    allowPdf: boolean("allow_pdf").notNull().default(true),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: varchar("created_by", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("quote_shares_token_hash_idx").on(table.tokenHash),
    index("quote_shares_tenant_quote_idx").on(table.tenantId, table.quoteId),
  ],
);

export const quoteShareEvents = pgTable(
  "quote_share_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    shareId: uuid("share_id")
      .notNull()
      .references(() => quoteShares.id, { onDelete: "cascade" }),
    event: quoteShareEventEnum("event").notNull(),
    meta: jsonb("meta").$type<JsonValue>(),
    ipHash: varchar("ip_hash", { length: 128 }),
    uaHash: varchar("ua_hash", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("quote_share_events_share_created_idx").on(table.shareId, table.createdAt),
    // 分享面板的 SQL 聚合按 (租户, 链接, 事件类型) 过滤后取时间；没有这条索引会退化为整表扫。
    index("quote_share_events_tenant_share_event_created_idx").on(
      table.tenantId,
      table.shareId,
      table.event,
      table.createdAt,
    ),
    // `count(distinct ip_hash)` 若没有按 ip_hash 有序的索引，会对全部 VIEWED 行做外部排序。
    index("quote_share_events_tenant_share_event_ip_idx").on(
      table.tenantId,
      table.shareId,
      table.event,
      table.ipHash,
    ),
  ],
);
