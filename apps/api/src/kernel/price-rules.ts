import type { Currency } from "@weave-order/schema";
import { KernelError } from "./errors";

/** 报价/订单行价格下限计算所需的最小样品信息。 */
export interface FloorSample {
  code: string;
  costFloor?: { amount: number; currency: Currency } | null;
  costFloorAmount?: number | null;
  costFloorCurrency?: Currency | null;
}

/** 样品成本底线（整数分 + 币种）。库里存在两种等价的落库形态，这里统一。 */
function sampleFloorOf(
  sample: FloorSample | undefined,
): { amount: number; currency: Currency | null } | null {
  if (!sample) return null;
  if (sample.costFloorAmount !== undefined && sample.costFloorAmount !== null) {
    return { amount: sample.costFloorAmount, currency: sample.costFloorCurrency ?? null };
  }
  if (sample.costFloor) {
    return { amount: sample.costFloor.amount, currency: sample.costFloor.currency };
  }
  return null;
}

/**
 * 取样品成本底线；缺失、为 0 或币种不符时直接拒绝。
 *
 * 这是报价（T-004 / T-006 / 改稿）共用的唯一口径：没有成本底线的样品
 * 不得产生可批准报价，而不是「没有下限 = 什么价都能批」。
 */
export function requireSampleCostFloor(
  sample: FloorSample | undefined,
  quoteCurrency: Currency,
): number {
  const floor = sampleFloorOf(sample);
  if (!floor || floor.amount <= 0) {
    throw new KernelError(
      "KERNEL_REJECTED",
      `样品 ${sample?.code ?? ""} 未维护成本底线，无法判定价格是否合规`,
      { reason: "COST_FLOOR_MISSING" },
    );
  }
  if (floor.currency !== null && floor.currency !== quoteCurrency) {
    throw new KernelError(
      "KERNEL_REJECTED",
      `样品 ${sample?.code ?? ""} 的成本底线币种与报价币种不一致，内核无法判定价格是否合规`,
      { reason: "CURRENCY_MISMATCH" },
    );
  }
  return floor.amount;
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
  const sampleFloor = sampleFloorOf(sample);
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
