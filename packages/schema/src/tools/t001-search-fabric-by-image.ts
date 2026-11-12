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

/**
 * T-001 输入有两种图像来源，二选一（不允许同时传）：
 * - `image`：base64，保留给已有后端/脚本；
 * - `imageUrl`：对象存储预签名 URL，移动端直传后使用（禁止把图片塞进 JSON base64）。
 *
 * URL 变体由服务端校验域名白名单 + 体积上限后取图，绝不直接信任客户端 URL。
 */
const T001Options = {
  topK: z.number().int().positive().max(50).default(5),
  minSimilarity: z.number().min(0).max(1).default(0.5),
} as const;

export const T001SearchFabricByImageBase64Input = z
  .object({ image: ImagePayload, ...T001Options })
  .strict();
export type T001SearchFabricByImageBase64Input = z.infer<typeof T001SearchFabricByImageBase64Input>;

export const T001SearchFabricByImageUrlInput = z
  .object({
    /** 必须是 http(s) 预签名 URL；服务端按 MEDIA_ALLOWED_HOSTS 白名单取图。 */
    imageUrl: z.string().url().max(2048),
    ...T001Options,
  })
  .strict();
export type T001SearchFabricByImageUrlInput = z.infer<typeof T001SearchFabricByImageUrlInput>;

export const T001SearchFabricByImageInput = z.union([
  T001SearchFabricByImageBase64Input,
  T001SearchFabricByImageUrlInput,
]);
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
