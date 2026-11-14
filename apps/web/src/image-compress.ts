/**
 * 桌面端上传前压缩（canvas）。
 *
 * 与移动端同一套预算：长边 ≤1600px、体积 ≤1MB。桌面图墙是主入口，
 * 服务端 `MEDIA_MAX_BYTES` 提到 10MB 只是「上限」，不能拿它当目标体积。
 *
 * 纯函数（`fitWithin` / `nextQuality`）单独导出，便于在没有 DOM 的环境测试。
 */

export const MAX_EDGE = 1600;
export const MAX_BYTES = 1024 * 1024;
const QUALITY_LADDER = [0.82, 0.74, 0.66, 0.58, 0.5, 0.42];

export interface Size {
  width: number;
  height: number;
}

export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): Size {
  if (width <= 0 || height <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function nextQuality(attempt: number): number {
  return QUALITY_LADDER[attempt] ?? QUALITY_LADDER[QUALITY_LADDER.length - 1]!;
}

export interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  byteSize: number;
  /** 本地预览地址（objectURL），调用方负责在保存后 revoke。 */
  previewUrl: string;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败"));
    };
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片压缩失败"))),
      "image/jpeg",
      quality,
    );
  });
}

/** 浏览器端压缩：长边 ≤1600 且 ≤1MB，必要时降质量 / 再等比缩小。 */
export async function compressImageFile(file: File): Promise<CompressedImage> {
  const image = await loadImage(file);
  let size = fitWithin(image.naturalWidth, image.naturalHeight);
  let canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持图片压缩");
  context.drawImage(image, 0, 0, size.width, size.height);

  for (let attempt = 0; attempt < QUALITY_LADDER.length + 3; attempt += 1) {
    const blob = await toBlob(canvas, nextQuality(attempt));
    if (blob.size <= MAX_BYTES) {
      return {
        blob,
        width: size.width,
        height: size.height,
        mimeType: "image/jpeg",
        byteSize: blob.size,
        previewUrl: URL.createObjectURL(blob),
      };
    }
    const shrunk = fitWithin(Math.round(size.width * 0.85), Math.round(size.height * 0.85));
    if (shrunk.width === size.width && shrunk.height === size.height) break;
    size = shrunk;
    canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const next = canvas.getContext("2d");
    if (!next) throw new Error("当前浏览器不支持图片压缩");
    next.drawImage(image, 0, 0, size.width, size.height);
  }
  const fallback = await toBlob(canvas, 0.4);
  return {
    blob: fallback,
    width: size.width,
    height: size.height,
    mimeType: "image/jpeg",
    byteSize: fallback.size,
    previewUrl: URL.createObjectURL(fallback),
  };
}

/** 直传预签名 URL；不经过业务 API 的 JSON body。 */
export async function uploadToPresignedUrl(
  uploadUrl: string,
  headers: Record<string, string>,
  blob: Blob,
): Promise<void> {
  const response = await fetch(uploadUrl, { method: "PUT", headers, body: blob });
  if (!response.ok) {
    throw new Error(`图片上传失败（HTTP ${response.status}）`);
  }
}
