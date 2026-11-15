import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import { inboundChannelEnum } from "./enums";
import { customers } from "./customers";

/**
 * 手工录入的客户回复（文本 / 截图 OCR 后的文本）。
 * 幂等键 `(tenant_id, channel, external_id)`：重放/重复提交只落一条。
 *
 * `customer_id` 由 API 层强制必填；列允许为空只为让 PR #70 期间可能存在的旧行能平滑迁移，
 * 旧行不会出现在客户 360（时间线按 customer_id 过滤），也不会被智能体取用。
 * `consumed_at` 是「这条回复已被智能体识别过」的标记，保证一条回复只驱动一次。
 * `raw_payload_expires_at` 到期后由 `maintain:inbound` 清空 `raw_payload`（默认 30 天）。
 */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    shipmentId: uuid("shipment_id"),
    channel: inboundChannelEnum("channel").notNull(),
    externalId: varchar("external_id", { length: 128 }).notNull(),
    customerRef: varchar("customer_ref", { length: 128 }),
    text: text("text").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    rawPayload: jsonb("raw_payload").$type<JsonValue>(),
    rawPayloadExpiresAt: timestamp("raw_payload_expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** 首次识别结论（重复提交时原样返回，不重复调用模型 / 不重复生成草稿）。 */
    classification: jsonb("classification").$type<JsonValue>(),
    /** 首次自动生成的报价草稿 id；重放时直接返回，保证「一条消息一份草稿」。 */
    quoteDraftId: uuid("quote_draft_id"),
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
      table.customerId,
      table.receivedAt,
    ),
    index("inbound_messages_tenant_shipment_idx").on(table.tenantId, table.shipmentId),
    index("inbound_messages_raw_expires_idx").on(table.rawPayloadExpiresAt),
  ],
);

export type InboundMessageRow = typeof inboundMessages.$inferSelect;
