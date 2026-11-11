import { z } from "zod";
import { toolResultSchema } from "../common";
import { FabricSample } from "../domain";

/**
 * T-001 search_fabric_by_image —— 找样智能体的以图搜图。
 *
 * 契约只关心「图像进、候选样品出」：embedding 由平台层的可替换 provider 生成，
 * 默认 local stub（不需要任何外部模型 key），真实 provider 留在接口后面。
 * 相似度是确定性数值，不信任 LLM 自述。
 */
export const ImagePayload = z
  .object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    /** base64（不含 data: 前缀） */
    base64: z.string().min(1).max(8_000_000),
  })
  .strict();
export type ImagePayload = z.infer<typeof ImagePayload>;

export const T001SearchFabricByImageInput = z
  .object({
    image: ImagePayload,
    topK: z.number().int().positive().max(50).default(5),
    minSimilarity: z.number().min(0).max(1).default(0.5),
  })
  .strict();
export type T001SearchFabricByImageInput = z.infer<typeof T001SearchFabricByImageInput>;

/** 以图搜图的一条候选结果。 */
export const ImageMatch = z
  .object({
    sample: FabricSample,
    /** cosine 相似度，0..1 */
    score: z.number().min(0).max(1),
  })
  .strict();
export type ImageMatch = z.infer<typeof ImageMatch>;

export const T001SearchFabricByImageData = z
  .object({
    embeddingModel: z.string().min(1).max(64),
    dimension: z.number().int().positive(),
    matches: z.array(ImageMatch),
  })
  .strict();
export type T001SearchFabricByImageData = z.infer<typeof T001SearchFabricByImageData>;

export const T001SearchFabricByImageResult = toolResultSchema(T001SearchFabricByImageData);
export type T001SearchFabricByImageResult = z.infer<typeof T001SearchFabricByImageResult>;
