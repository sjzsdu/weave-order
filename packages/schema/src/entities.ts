import { z } from "zod";
import { Currency, EntityId, Money, Quantity, Timestamp } from "./domain";

/**
 * 订单 / 发货 / 应收契约（T0 冻结）。
 *
 * 与现有 `sample_shipments`（寄样）严格区分：`shipments` 指订单发货。
 * 金额一律整数分（G6），状态流转只能经内核（G1）。
 */

export const OrderStatus = z.enum([
  "DRAFT",
  "CONFIRMED",
  "IN_PRODUCTION",
  "SHIPPED",
  "COMPLETED",
  "CANCELLED",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const OrderLineItem = z
  .object({
    id: EntityId,
    sampleId: EntityId,
    position: z.number().int().nonnegative(),
    description: z.string().min(1).max(255),
    quantity: Quantity,
    unitPrice: Money,
    lineTotal: Money,
  })
  .strict();
export type OrderLineItem = z.infer<typeof OrderLineItem>;

export const Order = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    customerId: EntityId,
    quoteId: EntityId.nullable(),
    code: z.string().min(1).max(64),
    status: OrderStatus,
    currency: Currency,
    items: z.array(OrderLineItem).min(1),
    total: Money,
    dueDate: Timestamp.nullable(),
    progressPct: z.number().int().min(0).max(100),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type Order = z.infer<typeof Order>;

export const CreateOrderInput = z
  .object({
    customerId: EntityId,
    quoteId: EntityId.nullable().optional(),
    /** 编号体系治理：可选，缺省由服务端按规则生成；显式传入则优先。 */
    code: z.string().min(1).max(64).optional(),
    currency: Currency,
    dueDate: Timestamp.nullable().optional(),
    items: z
      .array(
        z
          .object({
            sampleId: EntityId,
            quantity: Quantity,
            /** 仅作建议，内核复算并做成本底线校验。 */
            unitPrice: Money,
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

/** 订单发货单状态（非寄样）。 */
export const ShipmentStatus = z.enum(["DRAFT", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"]);
export type ShipmentStatus = z.infer<typeof ShipmentStatus>;

export const ShipmentLineItem = z
  .object({
    id: EntityId,
    orderItemId: EntityId,
    quantity: Quantity,
  })
  .strict();
export type ShipmentLineItem = z.infer<typeof ShipmentLineItem>;

export const Shipment = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    orderId: EntityId,
    status: ShipmentStatus,
    carrier: z.string().max(128).nullable(),
    trackingNumber: z.string().max(128).nullable(),
    address: z.string().max(500).nullable(),
    items: z.array(ShipmentLineItem).min(1),
    shippedAt: Timestamp.nullable(),
    deliveredAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type Shipment = z.infer<typeof Shipment>;

export const CreateShipmentInput = z
  .object({
    orderId: EntityId,
    carrier: z.string().max(128).nullable().optional(),
    trackingNumber: z.string().max(128).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    items: z
      .array(
        z
          .object({
            orderItemId: EntityId,
            quantity: Quantity,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type CreateShipmentInput = z.infer<typeof CreateShipmentInput>;

/** 应收状态。逾期由 status + dueDate 派生，不单独落库。 */
export const ReceivableStatus = z.enum(["PENDING", "PARTIAL", "PAID", "OVERDUE", "CANCELLED"]);
export type ReceivableStatus = z.infer<typeof ReceivableStatus>;

export const Receivable = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    orderId: EntityId,
    customerId: EntityId,
    amount: Money,
    paidAmount: Money,
    dueDate: Timestamp,
    status: ReceivableStatus,
    paidAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type Receivable = z.infer<typeof Receivable>;

export const CreateReceivableInput = z
  .object({
    orderId: EntityId,
    amount: Money,
    dueDate: Timestamp,
  })
  .strict();
export type CreateReceivableInput = z.infer<typeof CreateReceivableInput>;

/**
 * 单笔回款流水。
 *
 * `receivables.paidAmount` 只是累计值；「哪几笔回款」必须来自这张明细表，
 * 否则对账单只能看到总和，客户一问「这笔钱是哪天打的」就答不上来。
 */
export const ReceivablePayment = z
  .object({
    id: EntityId,
    tenantId: EntityId,
    receivableId: EntityId,
    amount: Money,
    paidAt: Timestamp,
    note: z.string().max(255).nullable(),
    /** 凭证图 object_key；读模型再转短期 URL，不直接回给前端。 */
    proofObjectKey: z.string().max(512).nullable(),
    recordedBy: z.string().max(128).nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type ReceivablePayment = z.infer<typeof ReceivablePayment>;

export const RecordPaymentInput = z
  .object({
    receivableId: EntityId,
    amount: Money,
    paidAt: Timestamp.optional(),
    note: z.string().max(255).nullish(),
    /** 只接受 `/api/media/presign` 为该应收签出的 key（服务端校验前缀）。 */
    proofObjectKey: z.string().max(512).nullish(),
  })
  .strict();
export type RecordPaymentInput = z.infer<typeof RecordPaymentInput>;
