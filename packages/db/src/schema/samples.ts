import { bigint, index, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { currencyEnum, sampleStatusEnum, unitEnum } from "./enums";

/**
 * 面料样品。
 * `costFloorAmount` 是内核报价时的价格底线（整数分）；
 * 智能体建议单价低于此线一律 KERNEL_REJECTED，LLM 无法绕过。
 */
export const samples = pgTable(
  "samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    composition: varchar("composition", { length: 255 }),
    /** 品类（定价继承的 CATEGORY 作用域）。 */
    category: varchar("category", { length: 64 }),
    /** 克重描述，如 "220g/m2" */
    weight: varchar("weight", { length: 64 }),
    unit: unitEnum("unit").notNull().default("meter"),
    costFloorAmount: bigint("cost_floor_amount", { mode: "number" }),
    costFloorCurrency: currencyEnum("cost_floor_currency"),
    status: sampleStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("samples_tenant_code_idx").on(table.tenantId, table.code),
    index("samples_name_idx").on(table.name),
  ],
);
