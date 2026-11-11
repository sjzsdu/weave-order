import { T004GenerateQuoteDraftInput, T004GenerateQuoteDraftResult } from "@weave-order/schema";
import type { T004GenerateQuoteDraftResult as Result } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { invalidInput, toToolError } from "./errors";

/**
 * T-004 generate_quote_draft。
 * 智能体提供建议单价与数量；行金额、总额由内核重算，
 * 返回的草稿一定是 DRAFT，等待人类在审批窗口确认。
 */
export function createGenerateQuoteDraftTool(kernel: Kernel) {
  return {
    id: "T-004",
    name: "generate_quote_draft",
    inputSchema: T004GenerateQuoteDraftInput,
    async execute(input: unknown, ctx: KernelContext): Promise<Result> {
      const parsed = T004GenerateQuoteDraftInput.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: invalidInput(parsed.error) };
      }
      try {
        const draft = await kernel.quotes.generateDraft(parsed.data, ctx);
        return T004GenerateQuoteDraftResult.parse({ ok: true, data: { draft } });
      } catch (error) {
        return T004GenerateQuoteDraftResult.parse({
          ok: false,
          error: toToolError(error),
        });
      }
    },
  };
}

export type GenerateQuoteDraftTool = ReturnType<typeof createGenerateQuoteDraftTool>;
