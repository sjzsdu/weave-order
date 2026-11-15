import { expect, test } from "../../support/test";
import { MEDIA_BASE_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import {
  GALLERY_CARDS,
  noHorizontalScroll,
  openGallery,
  screenshot,
  trackMediaRequests,
} from "../../support/ui";

/**
 * 样品图墙的三档视口验收（1280 / 1440 / 375）。
 *
 * 断言的是「布局事实」而不是像素：同一行的卡片顶边对齐、宽度一致、列数符合断点、
 * 375 下没有横向滚动。截图只给人看，不做像素回归。
 */
test.describe("样品图墙布局", () => {
  test("网格不错位、无横向滚动、首屏只拉缩略图", async ({ page }, testInfo) => {
    const mediaRequests = trackMediaRequests(page);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("缺少视口尺寸");

    const seed = await readSeed();
    const prefix = seed.fabricSamples[0]?.code.replace(/-\d+$/, "");
    if (!prefix) throw new Error("缺少共用图种子");
    const { filterAppliedAt } = await openGallery(page, prefix, 10);
    await noHorizontalScroll(page);

    const boxes = await page.locator(GALLERY_CARDS).evaluateAll((elements) =>
      elements.slice(0, 12).map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, left: rect.left, width: rect.width };
      }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(6);

    // 按 top 归行（允许 1px 亚像素误差），再断言同一行宽高一致、x 递增。
    const rows: { top: number; items: { left: number; width: number }[] }[] = [];
    for (const box of boxes) {
      const row = rows.find((candidate) => Math.abs(candidate.top - box.top) <= 1);
      if (row) row.items.push(box);
      else rows.push({ top: box.top, items: [box] });
    }
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const expectedColumns = viewport.width < 768 ? 2 : viewport.width >= 1280 ? 5 : 4;
    // 第一行必定是满行；第二行可能不满（种子 6 个时 5 列只有 1 个）。
    expect(rows[0]?.items.length).toBe(expectedColumns);
    for (const row of rows) {
      const width = row.items[0]?.width ?? 0;
      for (const item of row.items) {
        expect(Math.abs(item.width - width)).toBeLessThanOrEqual(1);
      }
      const lefts = row.items.map((item) => item.left);
      expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
    }

    /*
     * 「首屏只请求缩略图」的证据（WAN-125 之后）：
     * 服务端把缩略图派生成独立对象 `_320.webp`，不再是 `?w=320` 的 CDN 参数。
     * 因此用本次种子 API 返回的 thumbUrl 集合做比对：
     *   - 每个图片请求都必须命中某个 thumbUrl；
     *   - 任何请求都不能等于 `image.url`（原图 key）；
     *   - 旧环境（无派生、CDN 按参数出图）保留 `?w=320` 的降级分支。
     */
    const images = seed.fabricSamples.flatMap((sample) => sample.images);
    const thumbUrls = new Set(
      images.map((image) => image.thumbUrl).filter((url): url is string => url !== null),
    );
    expect(thumbUrls.size).toBe(images.length);
    const originalUrls = new Set(images.map((image) => image.url));
    // 页面首次加载会先请求未筛选列表的图；只统计「输入筛选词之后」的请求。
    const urls = mediaRequests
      .filter((request) => request.at >= filterAppliedAt)
      .map((request) => request.url);
    expect(urls.length).toBeGreaterThan(0);
    const nonThumbs = urls.filter(
      (url) => !thumbUrls.has(url) && new URL(url).searchParams.get("w") !== "320",
    );
    expect(nonThumbs, "图墙首屏出现了非缩略图请求").toEqual([]);
    const originalHits = urls.filter((url) => originalUrls.has(url));
    expect(originalHits, "图墙首屏请求了原图 key").toEqual([]);
    for (const url of urls) {
      expect(url.startsWith(MEDIA_BASE_URL)).toBe(true);
    }

    await screenshot(page, testInfo, "gallery");
  });
});
