import { z } from "zod";
import { toolResultSchema } from "../common";
import { EntityId, FabricSample } from "../domain";

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
  /**
   * 图-图 cosine 阈值。默认 0.75 —— 实测同款异角度 0.89~0.96、最易混异款 0.61~0.69，
   * 0.55 会把不同面料当成同款。调用方要放宽必须显式传值。
   */
  minSimilarity: z.number().min(0).max(1).default(0.75),
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
    /** cosine 相似度，0..1（原始 cosine，不做归一化） */
    score: z.number().min(0).max(1),
    /**
     * 命中的**具体那张图**：前端可以高亮「你拍的这张最像这个角度的这张图」。
     * caption 兜底时没有具体命中图，两个字段为 null（可选，向后兼容）。
     */
    matchedImageId: EntityId.nullable().optional(),
    matchedImageUrl: z.string().url().nullable().optional(),
    /** 可核对的命中理由（如「图像相似 87%」）；不放「AI 觉得像」这类无依据文案。 */
    reasons: z.array(z.string()).optional(),
  })
  .strict();
export type ImageMatch = z.infer<typeof ImageMatch>;

export const T001SearchFabricByImageData = z
  .object({
    embeddingModel: z.string().min(1).max(64),
    dimension: z.number().int().positive(),
    /**
     * `image`：真实图向量检索；`caption`：图向量不可用时的描述兜底。
     * 两种情况前端文案必须不同，绝不静默混用（可选，向后兼容老调用方）。
     */
    mode: z.enum(["image", "caption"]).optional(),
    /** 向量是否携带视觉语义；`local-stub` 演示模式为 false，前端要显式标注。 */
    semantic: z.boolean().optional(),
    /** 还有多少张样品图没有索引完：前端提示「结果可能不全」，而不是显示「无结果」。 */
    indexing: z.number().int().min(0).optional(),
    matches: z.array(ImageMatch),
  })
  .strict();
export type T001SearchFabricByImageData = z.infer<typeof T001SearchFabricByImageData>;

export const T001SearchFabricByImageResult = toolResultSchema(T001SearchFabricByImageData);
export type T001SearchFabricByImageResult = z.infer<typeof T001SearchFabricByImageResult>;
