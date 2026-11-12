import { pgEnum } from "drizzle-orm/pg-core";

/**
 * 数据库枚举与 packages/schema 的 Zod 枚举一一对应。
 * 契约的唯一来源仍是 Zod Schema；这里只是它在 PostgreSQL 上的物理表示，
 * 变更时必须两边同步（边界测试会校验取值集合一致）。
 */
export const customerTierEnum = pgEnum("customer_tier", ["VIP", "REGULAR", "NEW", "COLD"]);

export const currencyEnum = pgEnum("currency", ["CNY", "USD", "EUR", "HKD"]);

export const unitEnum = pgEnum("unit", ["meter", "kilogram", "yard", "piece"]);

export const sampleStatusEnum = pgEnum("sample_status", ["ACTIVE", "ARCHIVED"]);

export const shipmentStatusEnum = pgEnum("sample_shipment_status", [
  "DRAFT",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
]);

export const shipmentChannelEnum = pgEnum("shipment_channel", ["COURIER", "EXPRESS", "HAND_CARRY"]);

export const quoteStatusEnum = pgEnum("quote_status", [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
]);

/** 报价发送渠道：阶段一只有「人工导出后自己转发」。 */
export const quoteSendChannelEnum = pgEnum("quote_send_channel", ["MANUAL_EXPORT"]);

export const actorTypeEnum = pgEnum("actor_type", ["AGENT", "HUMAN", "SYSTEM"]);
