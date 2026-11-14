import Taro from "@tarojs/taro";
import type { MobileApi } from "./mobile-api";
import { MAX_BYTES, QUALITY_LADDER, fitWithin, isWithinBudget, nextQuality } from "./image-math";
import type { Size } from "./image-math";

/**
 * 图片前置条件：长边 ≤ 1600px、体积 ≤ 1MB，压缩后直传对象存储。
 * 铁律：任何图片都不许进 JSON base64；上传只走 presigned URL。
 */

export interface CompressedImage extends Size {
  /** 本地预览路径（H5 为 objectURL，小程序为临时文件）。 */
  path: string;
  byteSize: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** H5 才有 Blob，直传时不再转 base64。 */
  blob?: Blob;
}

function blobToSize(blob: Blob, mimeType: CompressedImage["mimeType"]): Promise<CompressedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () =>
      resolve({
        path: url,
        blob,
        byteSize: blob.size,
        mimeType,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片压缩失败"))),
      mimeType,
      quality,
    );
  });
}

async function compressH5(source: string): Promise<CompressedImage> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.crossOrigin = "anonymous";
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("图片加载失败"));
    element.src = source;
  });
  let size = fitWithin(image.naturalWidth, image.naturalHeight);
  let canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前设备不支持图片压缩");
  context.drawImage(image, 0, 0, size.width, size.height);

  for (let attempt = 0; attempt < QUALITY_LADDER.length + 3; attempt += 1) {
    const quality = nextQuality(attempt) ?? 0.4;
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (isWithinBudget(blob.size)) return blobToSize(blob, "image/jpeg");
    // 质量降到 0.42 仍超 1MB：再等比缩 85%，保持长边上限。
    const shrunk = fitWithin(Math.round(size.width * 0.85), Math.round(size.height * 0.85));
    if (shrunk.width === size.width && shrunk.height === size.height) break;
    size = shrunk;
    canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const nextContext = canvas.getContext("2d");
    if (!nextContext) throw new Error("当前设备不支持图片压缩");
    nextContext.drawImage(image, 0, 0, size.width, size.height);
  }
  const fallback = await canvasToBlob(canvas, "image/jpeg", 0.4);
  return blobToSize(fallback, "image/jpeg");
}

interface TaroOffscreenCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): {
    drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  } | null;
  createImage(): {
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
  };
}

interface TaroResizeApi {
  createOffscreenCanvas(options: {
    type: "2d";
    width: number;
    height: number;
  }): TaroOffscreenCanvas;
  canvasToTempFilePath(options: {
    canvas: unknown;
    x: number;
    y: number;
    width: number;
    height: number;
    destWidth: number;
    destHeight: number;
    fileType: "jpg";
    quality: number;
  }): Promise<{ tempFilePath: string }>;
}

async function taroResize(source: string, target: Size): Promise<string> {
  const api = Taro as unknown as TaroResizeApi;
  if (typeof api.createOffscreenCanvas !== "function") return source;
  const canvas = api.createOffscreenCanvas({
    type: "2d",
    width: target.width,
    height: target.height,
  });
  const context = canvas.getContext("2d");
  if (!context) return source;
  const image = canvas.createImage();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = source;
  });
  context.drawImage(image, 0, 0, target.width, target.height);
  const result = await api.canvasToTempFilePath({
    canvas,
    x: 0,
    y: 0,
    width: target.width,
    height: target.height,
    destWidth: target.width,
    destHeight: target.height,
    fileType: "jpg",
    quality: 0.85,
  });
  return result.tempFilePath;
}

async function compressTaro(source: string): Promise<CompressedImage> {
  const info = await Taro.getImageInfo({ src: source });
  const target = fitWithin(info.width, info.height);
  let path = source;
  if (target.width !== info.width || target.height !== info.height) {
    try {
      path = await taroResize(source, target);
    } catch {
      path = source;
    }
  }
  let byteSize = 0;
  try {
    const file = await Taro.getFileInfo({ filePath: path });
    byteSize = "size" in file ? file.size : MAX_BYTES;
  } catch {
    byteSize = MAX_BYTES;
  }
  let quality = 82;
  while (!isWithinBudget(byteSize) && quality > 30) {
    const compressed = await Taro.compressImage({ src: path, quality });
    path = compressed.tempFilePath;
    try {
      const file = await Taro.getFileInfo({ filePath: path });
      byteSize = "size" in file ? file.size : MAX_BYTES;
    } catch {
      break;
    }
    quality -= 12;
  }
  return {
    path,
    byteSize,
    mimeType: "image/jpeg",
    width: target.width,
    height: target.height,
  };
}

export async function compressImage(source: string): Promise<CompressedImage> {
  if (process.env.TARO_ENV === "h5") return compressH5(source);
  return compressTaro(source);
}

/** 直传对象存储；不经过业务 API 的 JSON body。 */
export async function uploadStoredMedia(
  stored: Blob | string,
  api: MobileApi,
  mimeType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
): Promise<string> {
  const blob = typeof Blob !== "undefined" && stored instanceof Blob ? stored : undefined;
  let byteSize = blob?.size ?? 0;
  if (typeof stored === "string") {
    try {
      const info = await Taro.getFileInfo({ filePath: stored });
      byteSize = "size" in info ? info.size : 0;
    } catch {
      byteSize = 0;
    }
  }
  const presign = await api.presignMedia({ mimeType, byteSize });

  if (presign.publicUrl.startsWith("mock://")) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return presign.publicUrl;
  }

  if (blob) {
    if (presign.method === "POST") {
      const form = new FormData();
      for (const [key, value] of Object.entries(presign.formData ?? {})) form.append(key, value);
      form.append("file", blob, "upload.jpg");
      const response = await fetch(presign.uploadUrl, { method: "POST", body: form });
      if (!response.ok) throw new Error(`上传失败（HTTP ${response.status}）`);
    } else {
      const response = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: presign.headers,
        body: blob,
      });
      if (!response.ok) throw new Error(`上传失败（HTTP ${response.status}）`);
    }
    return presign.publicUrl;
  }

  if (typeof stored !== "string") throw new Error("缺少本地图片路径");
  const result = await Taro.uploadFile({
    url: presign.uploadUrl,
    filePath: stored,
    name: "file",
    header: presign.headers,
    formData: presign.formData,
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`上传失败（HTTP ${result.statusCode}）`);
  }
  return presign.publicUrl;
}

export async function uploadImage(image: CompressedImage, api: MobileApi): Promise<string> {
  if (image.blob) return uploadStoredMedia(image.blob, api, image.mimeType);
  return uploadStoredMedia(image.path, api, image.mimeType);
}

/**
 * 把压缩后的图片直传到服务端签发的 PUT 地址（S1 的 presign/confirm 契约）。
 * H5 用 fetch + Blob；小程序没有 Blob，就按 ArrayBuffer 发原始 body，
 * 不能用 `Taro.uploadFile` —— 它固定 multipart，会破坏 S3 预签名的 Content-Type。
 */
export async function uploadImageToPresignedUrl(
  image: CompressedImage,
  upload: { uploadUrl: string; headers: Record<string, string> },
  mimeType: CompressedImage["mimeType"] = image.mimeType,
): Promise<void> {
  const headers = { ...upload.headers, "Content-Type": mimeType };
  if (typeof Blob !== "undefined" && image.blob instanceof Blob) {
    const response = await fetch(upload.uploadUrl, { method: "PUT", headers, body: image.blob });
    if (!response.ok) throw new Error(`上传失败（HTTP ${response.status}）`);
    return;
  }
  const fileSystem = (
    Taro as unknown as {
      getFileSystemManager?: () => {
        readFileSync(path: string): ArrayBuffer;
      };
    }
  ).getFileSystemManager?.();
  if (!fileSystem) throw new Error("当前端不支持读取本地图片");
  const data = fileSystem.readFileSync(image.path);
  const response = await Taro.request({
    url: upload.uploadUrl,
    method: "PUT",
    header: headers,
    data,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`上传失败（HTTP ${response.statusCode}）`);
  }
}

/** 离线时把照片落到本地，队列只存 mediaKey，不存 base64。 */
export async function persistImage(
  image: CompressedImage,
  store: { put(key: string, value: Blob | string): Promise<void> },
): Promise<string> {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (image.blob) await store.put(key, image.blob);
  else await store.put(key, image.path);
  return key;
}
