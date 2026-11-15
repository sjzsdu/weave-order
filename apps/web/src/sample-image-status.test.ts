import { describe, expect, it } from "vitest";
import type { SampleImage } from "@weave-order/schema";
import { canRetryImage, imageStatusBadges, thumbnailNote, thumbBadge } from "./sample-image-status";

function image(overrides: Partial<SampleImage> = {}): SampleImage {
  return {
    id: "img-1",
    url: "https://cdn.test/a.jpg",
    thumbUrl: "https://cdn.test/a_320.webp",
    detailUrl: "https://cdn.test/a_640.webp",
    thumbStatus: "ready",
    thumbError: null,
    variant: "primary",
    isPrimary: true,
    width: 320,
    height: 320,
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

describe("图片状态展示口径", () => {
  it("全部就绪时不产生任何徽标", () => {
    expect(imageStatusBadges(image())).toEqual([]);
    expect(canRetryImage(image())).toBe(false);
    expect(thumbBadge("ready", null)).toBeNull();
    expect(thumbnailNote(image())).toBeNull();
  });

  it("索引中与缩略图生成中都说成进行中，并给 warning 而非失败色", () => {
    const pending = image({ indexStatus: "pending", thumbStatus: "pending" });
    const badges = imageStatusBadges(pending);
    expect(badges.map((badge) => badge.label)).toEqual(["索引中", "缩略图生成中"]);
    for (const badge of badges) {
      expect(badge.tone).toBe("warning");
      expect(badge.reason).toBeNull();
    }
    expect(canRetryImage(pending)).toBe(false);
    expect(thumbBadge("pending", null)?.label).toBe("缩略图生成中");
    // 缩略图条只保留一条最要紧的：索引中优先于缩略图生成中。
    expect(thumbnailNote(pending)?.label).toBe("索引中");
  });

  it("失败态带上服务端原因，并且可以重试", () => {
    const failed = image({
      indexStatus: "failed",
      indexError: "模型返回 429",
      thumbStatus: "failed",
      thumbError: "对象不存在",
    });
    const badges = imageStatusBadges(failed);
    expect(badges.map((badge) => [badge.label, badge.tone, badge.reason])).toEqual([
      ["索引失败", "danger", "模型返回 429"],
      ["缩略图失败", "danger", "对象不存在"],
    ]);
    expect(canRetryImage(failed)).toBe(true);
    // 缩略图条优先说索引失败：没进向量库比缩略图失败更影响「找样」。
    expect(thumbnailNote(failed)?.label).toBe("索引失败");
    // 只有缩略图失败时，条上也只标注这一条。
    expect(thumbnailNote(image({ thumbStatus: "failed" }))?.label).toBe("缩略图失败");
  });

  it("图墙角标只看主图缩略图，失败时用服务端原因做 title", () => {
    expect(thumbBadge("failed", "解码失败")).toEqual({
      key: "thumb-failed",
      label: "缩略图失败",
      tone: "danger",
      reason: "解码失败",
    });
    // 没有原因也不能编：title 允许为空。
    expect(thumbBadge("failed", null)?.reason).toBeNull();
    // 未挂图（无主图）时静默，不制造「状态异常」的错觉。
    expect(thumbBadge(undefined, undefined)).toBeNull();
  });
});
