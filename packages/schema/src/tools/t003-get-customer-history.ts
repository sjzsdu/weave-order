import { z } from "zod";
import { toolResultSchema } from "../common";
import { Currency, Customer, CustomerContext, EntityId, Money, Timestamp } from "../domain";

/** 报价单摘要（历史列表用，不携带完整明细）。 */
export const QuoteSummary = z.object({
  id: EntityId,
  status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]),
  currency: Currency,
  total: Money,
  createdAt: Timestamp,
});
export type QuoteSummary = z.infer<typeof QuoteSummary>;

/** 订单摘要。 */
export const OrderSummary = z.object({
  id: EntityId,
  status: z.enum(["PENDING", "CONFIRMED", "IN_PRODUCTION", "SHIPPED", "COMPLETED", "CANCELLED"]),
  currency: Currency,
  total: Money,
  placedAt: Timestamp,
});
export type OrderSummary = z.infer<typeof OrderSummary>;

/** 样品摘要。 */
export const FabricSampleSummary = z.object({
  id: EntityId,
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  composition: z.string().nullable(),
  /** 克重描述，如 "220g/m2" */
  weight: z.string().nullable(),
});
export type FabricSampleSummary = z.infer<typeof FabricSampleSummary>;

/** T-003 输入：查询客户历史。 */
export const T003GetCustomerHistoryInput = z
  .object({
    customerId: EntityId,
    /** 各列表返回条数上限，默认 20 */
    limit: z.number().int().positive().max(200).default(20),
  })
  .strict();
export type T003GetCustomerHistoryInput = z.infer<typeof T003GetCustomerHistoryInput>;

/** T-003 成功数据。 */
export const T003GetCustomerHistoryData = z.object({
  customer: Customer,
  context: CustomerContext,
  recentQuotes: z.array(QuoteSummary),
  recentOrders: z.array(OrderSummary),
  recentSamples: z.array(FabricSampleSummary),
});
export type T003GetCustomerHistoryData = z.infer<typeof T003GetCustomerHistoryData>;

/** T-003 完整结果（成功 / 失败可判别）。 */
export const T003GetCustomerHistoryResult = toolResultSchema(T003GetCustomerHistoryData);
export type T003GetCustomerHistoryResult = z.infer<typeof T003GetCustomerHistoryResult>;
