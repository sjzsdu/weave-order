import type { SampleImage } from "@weave-order/schema";

/**
 * 图片处理状态的展示口径：只把「还没好」和「坏了」说出来，ready 不占版面。
 *
 * 为什么单独抽一层：图墙角标与详情徽标必须同一套文案，
 * 否则同一个 `thumb_status` 在两处会有两种说法，用户会以为是两件事。
 */
export interface ImageStatusBadge {
  key: "index-pending" | "index-failed" | "thumb-pending" | "thumb-failed";
  label: string;
  tone: "warning" | "danger";
  /** 服务端落库的原始原因（截断过）；只有失败态才有。 */
  reason: string | null;
}

export type ThumbStatus = SampleImage["thumbStatus"];

/** 详情抽屉：一张图的全部状态，按「索引 → 缩略图」顺序。 */
export function imageStatusBadges(image: SampleImage): ImageStatusBadge[] {
  const badges: ImageStatusBadge[] = [];
  if (image.indexStatus === "pending") {
    badges.push({ key: "index-pending", label: "索引中", tone: "warning", reason: null });
  }
  if (image.indexStatus === "failed") {
    badges.push({
      key: "index-failed",
      label: "索引失败",
      tone: "danger",
      reason: image.indexError ?? null,
    });
  }
  if (image.thumbStatus === "pending") {
    badges.push({ key: "thumb-pending", label: "缩略图生成中", tone: "warning", reason: null });
  }
  if (image.thumbStatus === "failed") {
    badges.push({
      key: "thumb-failed",
      label: "缩略图失败",
      tone: "danger",
      reason: image.thumbError ?? null,
    });
  }
  return badges;
}

/** 只有失败态值得给「重试」入口：pending 会自己完成，ready 无需操作。 */
export function canRetryImage(image: SampleImage): boolean {
  return image.indexStatus === "failed" || image.thumbStatus === "failed";
}

/**
 * 缩略图条上的极简标注：64px 宽度放不下完整句子，只保留最需要知道的那一条，
 * 完整原因在选中这张图后于大图下方展开。
 */
export function thumbnailNote(
  image: SampleImage,
): { label: string; tone: "warning" | "danger" } | null {
  if (image.indexStatus === "failed") return { label: "索引失败", tone: "danger" };
  if (image.thumbStatus === "failed") return { label: "缩略图失败", tone: "danger" };
  if (image.indexStatus === "pending") return { label: "索引中", tone: "warning" };
  if (image.thumbStatus === "pending") return { label: "生成中", tone: "warning" };
  return null;
}

/**
 * 图墙角标：只看主图缩略图。缩略图失败时接口回退的是原图（可能几十 MB），
 * 角标告诉用户「看到的大图不是缩略图」，而不是给每张图都加噪声。
 */
export function thumbBadge(
  thumbStatus: ThumbStatus | undefined,
  reason: string | null | undefined,
): ImageStatusBadge | null {
  if (thumbStatus === "failed") {
    return { key: "thumb-failed", label: "缩略图失败", tone: "danger", reason: reason ?? null };
  }
  if (thumbStatus === "pending") {
    return { key: "thumb-pending", label: "缩略图生成中", tone: "warning", reason: null };
  }
  return null;
}
