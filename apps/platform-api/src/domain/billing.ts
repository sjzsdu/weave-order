import type { BillingCycle, InvoiceLineItem, PlanPrice } from "@weave-order/schema";

/**
 * 确定性计费（纯函数，整数分）。
 * 计费口径：席位 × 单价；年付按合同年价收，MRR 用年价 / 12 折算。
 * token 只核算成本，不进账单金额（产品 §14.2）。
 */

export function annualToMonthlyCents(annualPriceCents: number): number {
  return Math.round(annualPriceCents / 12);
}

/** 合同月费：月付取月价，年付取年价 / 12（用于 MRR 与账单口径）。 */
export function effectiveMonthlyCents(
  price: Pick<PlanPrice, "monthlyPriceCents" | "annualPriceCents">,
  cycle: BillingCycle,
): number {
  return cycle === "ANNUAL"
    ? annualToMonthlyCents(price.annualPriceCents)
    : price.monthlyPriceCents;
}

/** 一个计费周期的席位费：年付收全年，月付收一月。 */
export function periodSeatChargeCents(
  price: Pick<PlanPrice, "monthlyPriceCents" | "annualPriceCents">,
  seats: number,
  cycle: BillingCycle,
): number {
  const unit = cycle === "ANNUAL" ? price.annualPriceCents : price.monthlyPriceCents;
  return unit * seats;
}

/** 价税分离：税额四舍五入到分，总额 = 小计 + 税。 */
export function invoiceTotals(
  subtotalCents: number,
  taxRateBp: number,
): { taxCents: number; totalCents: number } {
  const taxCents = Math.round((subtotalCents * taxRateBp) / 10_000);
  return { taxCents, totalCents: subtotalCents + taxCents };
}

/** 超出内置额度的 agent 动作包：默认 ¥0.05 / 次（5 分），只对超出部分计价。 */
export const DEFAULT_ACTION_OVERAGE_CENTS = 5;

export function actionOverageCents(
  used: number,
  quota: number,
  unitCents = DEFAULT_ACTION_OVERAGE_CENTS,
): { overageActions: number; overageCents: number } {
  const overageActions = Math.max(0, Math.trunc(used) - Math.trunc(quota));
  return { overageActions, overageCents: overageActions * unitCents };
}

export interface InvoiceDraftInput {
  seats: number;
  seatUnitCents: number;
  billingCycle: BillingCycle;
  usedActions: number;
  actionQuota: number;
  adjustments?: { description: string; amountCents: number }[];
}

export interface InvoiceDraft {
  lineItems: InvoiceLineItem[];
  subtotalCents: number;
}

/** 账单行：席位费 + 动作超额 + 手工调整（调整可为负，但小计不得为负）。 */
export function buildInvoiceLines(input: InvoiceDraftInput): InvoiceDraft {
  const lineItems: InvoiceLineItem[] = [];
  const seatAmount = input.seatUnitCents * input.seats;
  const cycleLabel = input.billingCycle === "ANNUAL" ? "年付席位费" : "月付席位费";
  lineItems.push({
    description: `${cycleLabel}（${input.seats} 席位）`,
    quantity: input.seats,
    unitPriceCents: input.seatUnitCents,
    amountCents: seatAmount,
  });

  const overage = actionOverageCents(input.usedActions, input.actionQuota);
  if (overage.overageCents > 0) {
    lineItems.push({
      description: `agent 动作超额（${overage.overageActions} 次 × ¥0.05）`,
      quantity: overage.overageActions,
      unitPriceCents: DEFAULT_ACTION_OVERAGE_CENTS,
      amountCents: overage.overageCents,
    });
  }

  for (const adjustment of input.adjustments ?? []) {
    lineItems.push({
      description: adjustment.description,
      quantity: 1,
      unitPriceCents: Math.abs(adjustment.amountCents),
      amountCents: adjustment.amountCents,
    });
  }

  const subtotalCents = lineItems.reduce((sum, line) => sum + line.amountCents, 0);
  if (subtotalCents < 0) {
    throw new Error("账单小计不能为负");
  }
  return { lineItems, subtotalCents };
}

/** 用量 80%/100%/110% 分档：只停新任务，绝不阻断审批、查看与导出。 */
export function quotaState(used: number, quota: number): "OK" | "WARN" | "BLOCK_NEW" | "REJECT" {
  if (quota <= 0) return "OK";
  const ratio = used / quota;
  if (ratio >= 1.1) return "REJECT";
  if (ratio >= 1) return "BLOCK_NEW";
  if (ratio >= 0.8) return "WARN";
  return "OK";
}

export function grossMarginBps(revenueCents: number, costCents: number): number {
  if (revenueCents <= 0) return 0;
  return Math.round(((revenueCents - costCents) / revenueCents) * 10_000);
}
