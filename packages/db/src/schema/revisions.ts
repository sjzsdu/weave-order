import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@weave-order/schema";
import {
  actorTypeEnum,
  revisionEntityTypeEnum,
  revisionRequestStatusEnum,
  revisionSourceEnum,
} from "./enums";

/** 结构化改稿原因字典（tenant 级配置）。 */
export const revisionReasons = pgTable(
  "revision_reasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    appliesTo: revisionEntityTypeEnum("applies_to").array().notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [uniqueIndex("revision_reasons_tenant_code_idx").on(table.tenantId, table.code)],
);

/** 改稿请求：人类意图 + 待批准的补丁。 */
export const revisionRequests = pgTable(
  "revision_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    entityType: revisionEntityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    source: revisionSourceEnum("source").notNull(),
    instruction: text("instruction").notNull(),
    patch: jsonb("patch").$type<JsonValue>().notNull(),
    status: revisionRequestStatusEnum("status").notNull().default("PENDING"),
    reasonId: uuid("reason_id").references(() => revisionReasons.id, { onDelete: "set null" }),
    baseVersion: integer("base_version").notNull().default(0),
    requestedByType: actorTypeEnum("requested_by_type").notNull(),
    requestedById: varchar("requested_by_id", { length: 128 }).notNull(),
    resolvedBy: varchar("resolved_by", { length: 128 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("revision_requests_entity_created_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index("revision_requests_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

/** 草稿修订版本：可回放的 patch + before/after + 出处。 */
export const draftRevisions = pgTable(
  "draft_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    revisionRequestId: uuid("revision_request_id").references(() => revisionRequests.id, {
      onDelete: "set null",
    }),
    entityType: revisionEntityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    version: integer("version").notNull(),
    patch: jsonb("patch").$type<JsonValue>().notNull(),
    before: jsonb("before").$type<JsonValue>().notNull(),
    after: jsonb("after").$type<JsonValue>().notNull(),
    provenance: jsonb("provenance").$type<JsonValue>().notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: varchar("actor_id", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("draft_revisions_entity_version_idx").on(
      table.tenantId,
      table.entityType,
      table.entityId,
      table.version,
    ),
  ],
);
