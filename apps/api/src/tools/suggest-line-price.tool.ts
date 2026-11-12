import { T006SuggestLinePriceInput, T006SuggestLinePriceResult } from "@weave-order/schema";
import type { T006SuggestLinePriceResult as Result } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { invalidInput, toToolError } from "./errors";

/**
 * T-006 suggest_line_price。
 * 返回确定性内核算出的建议单价 + 可点开的定价依据；智能体不得自行计算金额。
 */
export function createSuggestLinePriceTool(kernel: Kernel) {
  return {
    id: "T-006",
    name: "suggest_line_price",
    inputSchema: T006SuggestLinePriceInput,
    async execute(input: unknown, _ctx: KernelContext): Promise<Result> {
      const parsed = T006SuggestLinePriceInput.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: invalidInput(parsed.error) };
      }
      try {
        const pricing = await kernel.quotePricing.suggestLinePrice(parsed.data);
        return T006SuggestLinePriceResult.parse({ ok: true, data: { pricing } });
      } catch (error) {
        return T006SuggestLinePriceResult.parse({ ok: false, error: toToolError(error) });
      }
    },
  };
}

export type SuggestLinePriceTool = ReturnType<typeof createSuggestLinePriceTool>;
