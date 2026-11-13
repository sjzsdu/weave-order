import { bigint, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { currencyEnum, receivableStatusEnum } from "./enums";
import { customers } from "./customers";
import { orders } from "./orders";

/** 应收单。金额整数分；部分收款由内核累加 paidAmount。 */
export const receivables = pgTable(
  "receivables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    paidAmount: bigint("paid_amount", { mode: "number" }).notNull().default(0),
    currency: currencyEnum("currency").notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    status: receivableStatusEnum("status").notNull().default("PENDING"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("receivables_tenant_status_due_idx").on(table.tenantId, table.status, table.dueDate),
    index("receivables_tenant_customer_idx").on(table.tenantId, table.customerId),
  ],
);
