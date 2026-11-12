import type { Currency } from "@weave-order/schema";
import { KernelError } from "./errors";

/** 报价/订单行价格下限计算所需的最小样品信息。 */
export interface FloorSample {
  code: string;
  costFloor?: { amount: number; currency: Currency } | null;
  costFloorAmount?: number | null;
  costFloorCurrency?: Currency | null;
}

/**
 * 成本底线 + 最低毛利共同决定一行价格的下限（整数分，向上取整）。
 * 样品成本底线与公司管控底线取较高者；最低毛利是管控类策略，只能收紧。
 */
export function priceFloorOf(
  sample: FloorSample | undefined,
  quoteCurrency: Currency,
  minMarginPct: number,
  companyCostFloor: number,
): number {
  let base = Math.max(0, companyCostFloor);
  const sampleFloor =
    sample?.costFloorAmount !== undefined && sample?.costFloorAmount !== null
      ? { amount: sample.costFloorAmount, currency: sample.costFloorCurrency ?? null }
      : sample?.costFloor
        ? { amount: sample.costFloor.amount, currency: sample.costFloor.currency }
        : null;
  if (sampleFloor) {
    if (sampleFloor.currency !== null && sampleFloor.currency !== quoteCurrency) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `样品 ${sample?.code ?? ""} 的成本底线币种与报价币种不一致，内核无法判定价格是否合规`,
        { reason: "CURRENCY_MISMATCH" },
      );
    }
    base = Math.max(base, sampleFloor.amount);
  }
  if (base === 0 || minMarginPct <= 0) return base;
  const marginBps = Math.round(minMarginPct * 100);
  return Math.floor((base * (10_000 + marginBps) + 9999) / 10_000);
}
