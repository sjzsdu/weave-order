import { T003GetCustomerHistoryInput, T003GetCustomerHistoryResult } from "@weave-order/schema";
import type { T003GetCustomerHistoryResult as Result } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { invalidInput, toToolError } from "./errors";

/**
 * T-003 get_customer_history。
 * 智能体只拿到这个函数；它不能 import kernel，也不能触达数据库。
 */
export function createGetCustomerHistoryTool(kernel: Kernel) {
  return {
    id: "T-003",
    name: "get_customer_history",
    inputSchema: T003GetCustomerHistoryInput,
    async execute(input: unknown, ctx: KernelContext): Promise<Result> {
      const parsed = T003GetCustomerHistoryInput.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: invalidInput(parsed.error) };
      }
      try {
        const data = await kernel.customers.getHistory(
          parsed.data.customerId,
          parsed.data.limit,
          ctx,
        );
        return T003GetCustomerHistoryResult.parse({ ok: true, data });
      } catch (error) {
        return T003GetCustomerHistoryResult.parse({
          ok: false,
          error: toToolError(error),
        });
      }
    },
  };
}

export type GetCustomerHistoryTool = ReturnType<typeof createGetCustomerHistoryTool>;
export type { KernelContext };
