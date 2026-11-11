import { T001SearchFabricByImageInput, T001SearchFabricByImageResult } from "@weave-order/schema";
import type { T001SearchFabricByImageResult as Result } from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { invalidInput, toToolError } from "./errors";

/**
 * T-001 search_fabric_by_image。
 * 图像 -> embedding（provider 可替换）-> 内核 cosine 检索 -> 候选样品。
 */
export function createSearchFabricByImageTool(kernel: Kernel) {
  return {
    id: "T-001",
    name: "search_fabric_by_image",
    inputSchema: T001SearchFabricByImageInput,
    async execute(input: unknown, _ctx: KernelContext): Promise<Result> {
      const parsed = T001SearchFabricByImageInput.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: invalidInput(parsed.error) };
      }
      try {
        const data = await kernel.search.searchByImage(
          parsed.data.image,
          parsed.data.topK,
          parsed.data.minSimilarity,
        );
        return T001SearchFabricByImageResult.parse({ ok: true, data });
      } catch (error) {
        return T001SearchFabricByImageResult.parse({
          ok: false,
          error: toToolError(error),
        });
      }
    },
  };
}

export type SearchFabricByImageTool = ReturnType<typeof createSearchFabricByImageTool>;
