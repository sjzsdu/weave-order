import { bigint, check, index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { currencyEnum } from "./enums";
import { receivables } from "./receivables";

/**
 * 回款流水：`receivables.paid_amount` 的逐笔来源。
 *
 * 应收表只保留累计值（并发收款靠它做乐观条件），明细单独一行一笔，
 * 对账单据此回答「哪几笔订单、哪几笔回款」。金额整数分，不收浮点。
 */
export const receivablePayments = pgTable(
  "receivable_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    receivableId: uuid("receivable_id")
      .notNull()
      .references(() => receivables.id, { onDelete: "restrict" }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: currencyEnum("currency").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    note: varchar("note", { length: 255 }),
    /** 凭证图 object_key；URL 由 media 层按租户策略签发。 */
    proofObjectKey: varchar("proof_object_key", { length: 512 }),
    recordedBy: varchar("recorded_by", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 一笔回款必须为正：负数走红冲，而不是把负数混进收款流水。
    check("receivable_payments_amount_positive", sql`${table.amount} > 0`),
    index("receivable_payments_tenant_receivable_idx").on(
      table.tenantId,
      table.receivableId,
      table.paidAt,
    ),
    index("receivable_payments_tenant_paid_at_idx").on(table.tenantId, table.paidAt),
  ],
);
