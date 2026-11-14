import sharp from "sharp";

/**
 * 送多模态模型之前的图片预处理。
 *
 * 为什么要缩：图片按 token 计费，而 token 数随面积走（实测 `qwen3-vl-embedding`：
 * 256px = 64 token、512px = 256 token、1024px = 1024 token、手机原图封顶 1225）。
 * 分离度在 256~512px 与 1024px 基本持平（差 0.006，在噪声内），
 * 所以「先缩再送」是纯收益：单图成本降 4~19 倍，索引/查询延迟同比例下降。
 *
 * 客户端压缩（长边 ≤1600px / ≤1MB）是为存储与展示，不是为 embedding —— 两者目标不同。
 */
export interface EmbeddingImage {
  mimeType: string;
  base64: string;
}

export const DEFAULT_EMBEDDING_MAX_EDGE = 512;

/**
 * 把图片缩到长边 `maxEdge` 以内并统一转 JPEG。
 *
 * - `rotate()` 先按 EXIF 摆正：手机竖拍的布料照片不摆正会让「纹理方向」失真；
 * - `withoutEnlargement`：小图不放大（放大既浪费 token 又不会更清楚）；
 * - `maxEdge <= 0` 表示不处理（测试用假图片时关掉，避免依赖可解码的真实图片）。
 */
export async function resizeForEmbedding(
  image: EmbeddingImage,
  maxEdge: number,
): Promise<EmbeddingImage> {
  if (maxEdge <= 0) return image;
  const input = Buffer.from(image.base64, "base64");
  if (input.length === 0) throw new Error("图像内容为空，无法缩图");
  try {
    const output = await sharp(input)
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { mimeType: "image/jpeg", base64: output.toString("base64") };
  } catch (error) {
    // 解不开就明确失败：索引状态会变 failed，图墙显示「索引失败」，
    // 而不是拿一段无法解码的字节去换一个「看起来正常」的向量。
    throw new Error(
      `图片无法解码/缩放（mimeType=${image.mimeType}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
