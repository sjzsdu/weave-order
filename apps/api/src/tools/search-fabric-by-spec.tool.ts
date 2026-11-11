import { T002SearchFabricBySpecInput, T002SearchFabricBySpecResult } from "@weave-order/schema";
import type { T002SearchFabricBySpecResult as Result } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { invalidInput, toToolError } from "./errors";

/**
 * T-002 search_fabric_by_spec。
 * 参数匹配是确定性 SQL + 命中字段说明；相关性不交给 LLM 编。
 */
export function createSearchFabricBySpecTool(kernel: Kernel) {
  return {
    id: "T-002",
    name: "search_fabric_by_spec",
    inputSchema: T002SearchFabricBySpecInput,
    async execute(input: unknown, _ctx: KernelContext): Promise<Result> {
      const parsed = T002SearchFabricBySpecInput.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: invalidInput(parsed.error) };
      }
      try {
        const data = await kernel.search.searchBySpec(parsed.data);
        return T002SearchFabricBySpecResult.parse({ ok: true, data });
      } catch (error) {
        return T002SearchFabricBySpecResult.parse({
          ok: false,
          error: toToolError(error),
        });
      }
    },
  };
}

export type SearchFabricBySpecTool = ReturnType<typeof createSearchFabricBySpecTool>;
