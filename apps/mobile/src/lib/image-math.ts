/**
 * 图片压缩的纯计算部分（不依赖 Taro / DOM，便于单测）。
 * 端侧压缩实现见 `media.ts`。
 */

export const MAX_EDGE = 1600;
export const MAX_BYTES = 1024 * 1024;
export const QUALITY_LADDER = [0.82, 0.72, 0.62, 0.52, 0.42] as const;

export interface Size {
  width: number;
  height: number;
}

/** 长边等比缩到 maxEdge 以内；小图不放大。 */
export function fitWithin(width: number, height: number, maxEdge: number = MAX_EDGE): Size {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function nextQuality(attempt: number): number | null {
  return QUALITY_LADDER[attempt] ?? null;
}

export function isWithinBudget(byteSize: number): boolean {
  return byteSize <= MAX_BYTES;
}
