import { QuoteDocumentSnapshot } from "@weave-order/schema";
import type { QuoteCompanyHeader, QuoteDetail } from "@weave-order/schema";

export interface BuildSnapshotInput {
  detail: QuoteDetail;
  company: QuoteCompanyHeader;
  terms: string[];
  /** 生成时间由调用方给，保证同一份输入得到同一份快照（测试可复现）。 */
  generatedAt: Date;
}

/**
 * 把内核读出的报价明细固化成「客户实际看到的那一版内容」。
 *
 * 这个快照既是 PDF 的唯一渲染来源，也是发送记录里不可变的版本依据：
 * 同一条发送记录永远能还原当时的价格、数量、有效期与条款。
 */
export function buildQuoteDocumentSnapshot(input: BuildSnapshotInput): QuoteDocumentSnapshot {
  const { detail, company, terms, generatedAt } = input;
  return QuoteDocumentSnapshot.parse({
    company,
    customer: {
      code: detail.customer.code,
      name: detail.customer.name,
      contactName: detail.customer.contactName,
      contactPhone: detail.customer.contactPhone,
      contactEmail: detail.customer.contactEmail,
    },
    quote: {
      id: detail.id,
      currency: detail.currency,
      subtotalCents: detail.subtotal.amount,
      totalCents: detail.total.amount,
      validityDays: detail.validityDays,
      expiresAt: detail.expiresAt,
      createdAt: detail.createdAt,
      confirmedAt: detail.confirmedAt,
      confirmedBy: detail.confirmedBy,
      remarks: detail.remarks,
    },
    lines: detail.items.map((item, index) => ({
      position: index,
      description: item.description,
      quantity: item.quantity.value,
      unit: item.quantity.unit,
      unitPriceCents: item.unitPrice.amount,
      lineTotalCents: item.lineTotal.amount,
    })),
    terms,
    generatedAt: generatedAt.toISOString(),
  });
}
