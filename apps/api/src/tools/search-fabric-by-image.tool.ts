import { T001SearchFabricByImageInput, T001SearchFabricByImageResult } from "@weave-order/schema";
import type {
  ImagePayload,
  T001SearchFabricByImageResult as Result,
  ToolError,
} from "@weave-order/schema";
import type { Kernel, KernelContext } from "../kernel";
import { createImageFetcherFromEnv } from "../platform/media";
import type { ImageFetcher } from "../platform/media";
import { invalidInput, toToolError } from "./errors";

/**
 * T-001 search_fabric_by_image。
 * 图像 -> embedding（provider 可替换）-> 内核 cosine 检索 -> 候选样品。
 *
 * 图像来源二选一：`image`（base64，兼容旧调用）或 `imageUrl`（移动端直传后）。
 * URL 变体先经过 platform/media 的白名单取图，再复用同一条 embedding 检索链路。
 */
export function createSearchFabricByImageTool(
  kernel: Kernel,
  imageFetcher: ImageFetcher = createImageFetcherFromEnv(),
) {
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
        let image: ImagePayload;
        if ("image" in parsed.data) {
          image = parsed.data.image;
        } else {
          try {
            image = await imageFetcher.fetchImage(parsed.data.imageUrl);
          } catch (error) {
            const failure: ToolError = {
              code: "UPSTREAM_UNAVAILABLE",
              dependency: "object_storage",
              message: error instanceof Error ? error.message : "按 URL 取图失败",
            };
            return { ok: false, error: failure };
          }
        }
        const data = await kernel.search.searchByImage(
          image,
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
