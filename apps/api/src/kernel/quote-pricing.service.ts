import { QuotePricingBasis, T006SuggestLinePriceInput } from "@weave-order/schema";
import type { PricingBasisComponent } from "@weave-order/schema";
import type { CustomerService } from "./customers.service";
import { KernelError } from "./errors";
import { PricingService, numericValue } from "./pricing.service";
import type { SampleService } from "./samples.service";

/** 报价单位价取整到整元（100 分），避免出现 14.37 这类不体面的单价。 */
const ROUND_TO_CENTS = 100;

function ceilTo(amount: number, step: number): number {
  return Math.ceil(amount / step) * step;
}

/**
 * 报价场景的确定性定价（T-006）。
 *
 * Track A 的 `PricingService` 负责策略继承与管控夹取；这里只做报价场景的
 * 「成本底线 → 默认毛利 → 整元取整」换算，所有数字仍由内核给出。
 * agent 只拿到结果，不能自己算金额。
 */
export class QuotePricingService {
  constructor(
    private readonly customers: CustomerService,
    private readonly samples: SampleService,
    private readonly pricing: PricingService,
  ) {}

  async suggestLinePrice(input: unknown): Promise<QuotePricingBasis> {
    const parsed = T006SuggestLinePriceInput.parse(input);
    const customer = await this.customers.getById(parsed.customerId);
    const sample = await this.samples.getById(parsed.fabricSampleId);

    if (parsed.quantity.unit !== sample.unit) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `数量单位 ${parsed.quantity.unit} 与样品 ${sample.code} 的单位 ${sample.unit} 不一致`,
        { reason: "UNIT_MISMATCH" },
      );
    }
    if (!sample.costFloor) {
      throw new KernelError("KERNEL_REJECTED", `样品 ${sample.code} 未维护成本底线，无法定价`, {
        reason: "COST_FLOOR_MISSING",
      });
    }
    if (sample.costFloor.currency !== parsed.currency) {
      throw new KernelError("KERNEL_REJECTED", "成本底线币种与报价币种不一致", {
        reason: "CURRENCY_MISMATCH",
      });
    }

    const [marginResolved, floorResolved] = await Promise.all([
      this.pricing.resolve("pricing.default_margin_pct", { customerId: customer.id }),
      this.pricing.resolve("pricing.cost_floor_amount", { customerId: customer.id }),
    ]);
    const marginPct = numericValue(marginResolved.value) ?? 20;
    const companyFloor = parsed.currency === "CNY" ? (numericValue(floorResolved.value) ?? 0) : 0;

    const costFloorAmount = Math.max(sample.costFloor.amount, companyFloor);
    const markupBps = Math.max(0, Math.round(marginPct * 100));
    const markupAmount = Math.round((costFloorAmount * markupBps) / 10_000);
    const beforeRounding = costFloorAmount + markupAmount;
    const suggestedAmount = Math.max(costFloorAmount, ceilTo(beforeRounding, ROUND_TO_CENTS));
    const roundingAmount = suggestedAmount - beforeRounding;

    const components: PricingBasisComponent[] = [
      {
        kind: "COST_FLOOR",
        label: "成本底线",
        amount: { amount: costFloorAmount, currency: parsed.currency },
        rateBps: null,
        source:
          companyFloor > sample.costFloor.amount
            ? `pricing_policies: pricing.cost_floor_amount（${floorResolved.source.scopeType}）`
            : `samples.cost_floor（${sample.code}）`,
        note: "低于该价格的报价会被内核拒绝",
      },
      {
        kind: "POLICY",
        label: `默认毛利（${marginPct}%）`,
        amount: { amount: markupAmount, currency: parsed.currency },
        rateBps: markupBps,
        source: `pricing_policies: pricing.default_margin_pct（${marginResolved.source.scopeType}）`,
        note: marginResolved.clamped ? "已被管控策略夹取" : null,
      },
    ];
    if (roundingAmount > 0) {
      components.push({
        kind: "ROUNDING",
        label: "单价整元取整",
        amount: { amount: roundingAmount, currency: parsed.currency },
        rateBps: null,
        source: "kernel.quotePricing.rounding",
        note: "向上取整到 1 元（100 分）",
      });
    }
    components.push({
      kind: "POLICY",
      label: "生效单价",
      amount: { amount: suggestedAmount, currency: parsed.currency },
      rateBps: null,
      source: "kernel.quotes.generateDraft",
      note: "生成 DRAFT 时由内核复核成本底线、币种与单位",
    });

    return QuotePricingBasis.parse({
      customerId: customer.id,
      fabricSampleId: sample.id,
      currency: parsed.currency,
      quantity: parsed.quantity,
      costFloor: { amount: costFloorAmount, currency: parsed.currency },
      markupRateBps: markupBps,
      suggestedUnitPrice: { amount: suggestedAmount, currency: parsed.currency },
      components,
      computedBy: "KERNEL",
    });
  }
}
