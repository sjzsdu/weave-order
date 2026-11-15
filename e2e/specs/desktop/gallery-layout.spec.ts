import { expect, test } from "@playwright/test";
import { MEDIA_BASE_URL } from "../../support/env";
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

    await openGallery(page, "E2E-FAB", 10);
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

    // 首屏每一张图都必须是 `?w=320` 的缩略图，不能出现原图 key。
    expect(mediaRequests.length).toBeGreaterThan(0);
    const withoutThumbParam = mediaRequests.filter((url) => {
      const parsed = new URL(url);
      return parsed.searchParams.get("w") !== "320";
    });
    expect(withoutThumbParam, "图墙首屏出现了非缩略图请求").toEqual([]);
    for (const url of mediaRequests) {
      expect(url.startsWith(MEDIA_BASE_URL)).toBe(true);
    }

    await screenshot(page, testInfo, "gallery");
  });
});
