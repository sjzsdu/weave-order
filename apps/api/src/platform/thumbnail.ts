import sharp from "sharp";
import type { Env } from "./env";
import { mediaBaseUrl } from "./storage";
import type { ObjectStorage } from "./storage";

/**
 * 持久化缩略图（不是 S4 送给模型的临时缩放）。
 *
 * 为什么落盘：
 * - 本地 MinIO 没有图片处理能力，`?w=320` 既不会缩图也会破坏签名；
 * - 「图墙只拉缩略图」必须是**无条件**成立的，不能依赖生产配了 CDN 图片处理；
 * - 稳定 key + 可缓存，存量图片可以幂等回填。
 *
 * key 规则延续 S1 契约：`tenant/<tid>/samples/<sid>/thumbs/<imageId>_<width>.webp`。
 * DB 只存 key；换 CDN / 换桶仍然只改 `MEDIA_BASE_URL`。
 */
export const THUMB_WIDTHS = [320, 640] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

/** 图墙首屏用 320，详情抽屉用 640。 */
export const WALL_THUMB_WIDTH: ThumbWidth = 320;
export const DETAIL_THUMB_WIDTH: ThumbWidth = 640;

export function thumbObjectKey(
  tenantId: string,
  sampleId: string,
  imageId: string,
  width: ThumbWidth,
): string {
  return `tenant/${tenantId}/samples/${sampleId}/thumbs/${imageId}_${width}.webp`;
}

/** 按长边缩到 `width` 以内并转 webp；小图不放大（放大只增加字节，不会更清楚）。 */
export async function renderThumbnail(
  source: Buffer,
  width: ThumbWidth,
  quality = 72,
): Promise<Buffer> {
  if (source.length === 0) throw new Error("图像内容为空，无法生成缩略图");
  try {
    const output = await sharp(source)
      // 手机竖拍带 EXIF：不摆正会让缩略图方向与详情页相反。
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    if (output.length === 0) throw new Error("缩略图输出为空");
    return output;
  } catch (error) {
    throw new Error(
      `图片无法解码/生成缩略图：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface ReencodedImage {
  bytes: Buffer;
  contentType: string;
  width: number | null;
  height: number | null;
}

/**
 * 超大原图重编码。
 *
 * 选择「原 key 不变、覆盖写」而不是新增 `originalKey`：
 * 本任务明确不做图片版本管理，保留旧字节既不省存储也不省带宽；
 * 覆盖后扩展名与 mime 保持一致（jpeg 仍是 jpeg），不会出现 `.jpg` 装 webp 的契约裂缝。
 */
export async function reencodeOversizedOriginal(
  source: Buffer,
  mimeType: string,
  quality = 82,
): Promise<ReencodedImage> {
  if (source.length === 0) throw new Error("图像内容为空，无法重编码");
  try {
    const base = sharp(source).rotate();
    const meta = await base.metadata();
    const pipeline =
      mimeType === "image/png"
        ? base.png({ compressionLevel: 9, palette: true })
        : mimeType === "image/webp"
          ? base.webp({ quality })
          : base.jpeg({ quality, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      contentType: mimeType,
      width: info.width ?? meta.width ?? null,
      height: info.height ?? meta.height ?? null,
    };
  } catch (error) {
    throw new Error(`图片无法重编码：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 对象读地址：配了公开域名走 CDN，否则发短期签名 URL。 */
export async function objectUrl(
  env: Env,
  storage: ObjectStorage | null,
  objectKey: string,
): Promise<string | null> {
  if (env.MEDIA_BASE_URL) return `${mediaBaseUrl(env)}/${objectKey}`;
  if (!storage) return null;
  return storage.signGet(objectKey, env.MEDIA_PRESIGN_TTL_SECONDS);
}
