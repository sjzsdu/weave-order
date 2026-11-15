import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import { inboundChannelEnum } from "./enums";

/**
 * 手工录入的客户回复（文本 / 截图 OCR 后的文本）。
 * 幂等键 `(tenant_id, channel, external_id)`：重放/重复提交只落一条。
 */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    channel: inboundChannelEnum("channel").notNull(),
    externalId: varchar("external_id", { length: 128 }).notNull(),
    customerRef: varchar("customer_ref", { length: 128 }),
    text: text("text").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    rawPayload: jsonb("raw_payload").$type<JsonValue>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inbound_messages_tenant_channel_external_idx").on(
      table.tenantId,
      table.channel,
      table.externalId,
    ),
    index("inbound_messages_tenant_customer_received_idx").on(
      table.tenantId,
      table.customerRef,
      table.receivedAt,
    ),
  ],
);

export type InboundMessageRow = typeof inboundMessages.$inferSelect;
