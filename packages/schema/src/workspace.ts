import { z } from "zod";
import { Currency, Customer, EntityId, Money, Timestamp } from "./domain";
import {
  Order,
  OrderStatus,
  Receivable,
  ReceivablePayment,
  ReceivableStatus,
  Shipment,
} from "./entities";
import { SampleShipment } from "./domain";
import { QuoteStatus } from "./domain";

/**
 * 订单工作台 / 应收对账的读模型契约。
 *
 * 这些都是「列表页 + 详情页」的一次性聚合，不是内核账本实体：
 * 金额一律是整数分，逾期、余额、已发未发全部由服务端派生，
 * 前端只渲染，不做任何加减。
 */

/** 漏斗阶段：数字可点，点进去必须正好等于该阶段的订单数。 */
export const OrderFunnelStageKey = z.enum(["DRAFT", "CONFIRMED", "IN_PRODUCTION", "SHIPPED"]);
export type OrderFunnelStageKey = z.infer<typeof OrderFunnelStageKey>;

export const OrderFunnelStage = z
  .object({
    key: OrderFunnelStageKey,
    label: z.string().min(1).max(32),
    /** 该阶段包含的订单状态；点击时前端直接把 statuses 传给列表接口。 */
    statuses: z.array(OrderStatus).min(1),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type OrderFunnelStage = z.infer<typeof OrderFunnelStage>;

export const OrderFunnel = z
  .object({
    stages: z.array(OrderFunnelStage),
    generatedAt: Timestamp,
  })
  .strict();
export type OrderFunnel = z.infer<typeof OrderFunnel>;

export const OrderLastAction = z
  .object({
    action: z.string().min(1).max(64),
    actorType: z.string().min(1).max(16),
    at: Timestamp,
  })
  .strict();
export type OrderLastAction = z.infer<typeof OrderLastAction>;

/** 订单列表行：列表只需读到这一层，不拉行项目。 */
export const OrderListItem = z
  .object({
    id: EntityId,
    code: z.string().min(1).max(64),
    customerId: EntityId,
    customerName: z.string().min(1).max(255),
    customerCode: z.string().min(1).max(64),
    status: OrderStatus,
    currency: Currency,
    total: Money,
    dueDate: Timestamp.nullable(),
    /** 订单行数。 */
    itemCount: z.number().int().nonnegative(),
    /** 已全部发完的订单行数（按行数量比对，不跨单位汇总）。 */
    shippedLineCount: z.number().int().nonnegative(),
    /** 交期已过且未完成/未取消。 */
    overdue: z.boolean(),
    lastAction: OrderLastAction.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type OrderListItem = z.infer<typeof OrderListItem>;

export const OrderListResponse = z
  .object({
    orders: z.array(OrderListItem),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type OrderListResponse = z.infer<typeof OrderListResponse>;

/** 订单详情里「关联报价」只需要认得出来源，不需要整张报价的草稿内容。 */
export const OrderQuoteRef = z
  .object({
    id: EntityId,
    status: QuoteStatus,
    total: Money,
    createdAt: Timestamp,
  })
  .strict();
export type OrderQuoteRef = z.infer<typeof OrderQuoteRef>;

/** 订单详情工作面：行项目 + 关联报价 + 寄样记录 + 发货记录。 */
export const OrderWorkbench = z
  .object({
    order: Order,
    customer: Customer,
    quote: OrderQuoteRef.nullable(),
    shipments: z.array(Shipment),
    /** 同一客户的寄样记录（寄样单以客户为单位，不挂订单）。 */
    sampleShipments: z.array(SampleShipment),
  })
  .strict();
export type OrderWorkbench = z.infer<typeof OrderWorkbench>;

/** 应收分组：逾期 / 本月到期 / 已结清；all 用于导出与跨组浏览。 */
export const ReceivableBucket = z.enum(["overdue", "dueSoon", "settled", "all"]);
export type ReceivableBucket = z.infer<typeof ReceivableBucket>;

export const ReceivableListItem = z
  .object({
    id: EntityId,
    orderId: EntityId,
    orderCode: z.string().min(1).max(64),
    customerId: EntityId,
    customerName: z.string().min(1).max(255),
    customerCode: z.string().min(1).max(64),
    amount: Money,
    paidAmount: Money,
    balance: Money,
    /** 逾期由 dueDate 派生，不落库。 */
    status: ReceivableStatus,
    dueDate: Timestamp,
    daysOverdue: z.number().int().nonnegative(),
    lastPaymentAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type ReceivableListItem = z.infer<typeof ReceivableListItem>;

export const CurrencyTotal = z
  .object({
    currency: Currency,
    amount: z.number().int().nonnegative(),
  })
  .strict();
export type CurrencyTotal = z.infer<typeof CurrencyTotal>;

export const ReceivableListSummary = z
  .object({
    overdue: z.number().int().nonnegative(),
    dueSoon: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    /** 未收余额（按币种分开，绝不跨币种相加）。 */
    balanceByCurrency: z.array(CurrencyTotal),
  })
  .strict();
export type ReceivableListSummary = z.infer<typeof ReceivableListSummary>;

export const ReceivableListResponse = z
  .object({
    receivables: z.array(ReceivableListItem),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    summary: ReceivableListSummary,
  })
  .strict();
export type ReceivableListResponse = z.infer<typeof ReceivableListResponse>;

/** 回款流水读模型：凭证图只暴露短期可读 URL，不暴露 object_key。 */
export const ReceivablePaymentView = z
  .object({
    id: EntityId,
    receivableId: EntityId,
    amount: Money,
    paidAt: Timestamp,
    note: z.string().max(255).nullable(),
    proofUrl: z.string().nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type ReceivablePaymentView = z.infer<typeof ReceivablePaymentView>;

export const ReceivablePaymentsResponse = z
  .object({
    payments: z.array(ReceivablePaymentView),
  })
  .strict();
export type ReceivablePaymentsResponse = z.infer<typeof ReceivablePaymentsResponse>;

export const ReceivableStatementLine = z
  .object({
    receivable: Receivable,
    orderCode: z.string().min(1).max(64),
    payments: z.array(ReceivablePaymentView),
  })
  .strict();
export type ReceivableStatementLine = z.infer<typeof ReceivableStatementLine>;

/**
 * 客户对账单：哪几笔订单、哪几笔回款，一行一笔来源。
 * totals 按币种分开，页面与打印直接读同一组整数分，浮点误差为 0。
 */
export const ReceivableStatement = z
  .object({
    customer: Customer,
    from: Timestamp.nullable(),
    to: Timestamp.nullable(),
    lines: z.array(ReceivableStatementLine),
    totalsByCurrency: z.array(
      z
        .object({
          currency: Currency,
          amount: z.number().int().nonnegative(),
          paid: z.number().int().nonnegative(),
          balance: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    /** 历史收款只有汇总、没有流水时的差额（升级前的数据），单独列出不藏。 */
    legacyPaidByCurrency: z.array(CurrencyTotal),
    generatedAt: Timestamp,
  })
  .strict();
export type ReceivableStatement = z.infer<typeof ReceivableStatement>;

export type ReceivablePaymentEntity = z.infer<typeof ReceivablePayment>;
