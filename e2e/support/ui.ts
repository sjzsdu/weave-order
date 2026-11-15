import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { ARTIFACTS_DIR, MEDIA_BASE_URL } from "./env";

export const SCREENSHOTS_DIR = path.join(ARTIFACTS_DIR, "screenshots");

/** 图墙卡片：三种视口下都靠这个选择器取网格。 */
export const GALLERY_CARDS = "main ul.grid-cols-2 > li";

export async function openGallery(
  page: Page,
  query?: string,
  minCards = 6,
): Promise<{ filterAppliedAt: number }> {
  if (query) {
    // 首屏会先请求「未筛选」列表：那批卡片会在筛选生效前触发自己的缩略图请求，
    // 污染「首屏只拉缩略图」的证据。直接掐掉未带 query 的列表请求，
    // 让页面只呈现本次种子（数据是共享库，断言必须收敛）。
    await page.route("**/api/samples?*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.get("query")) {
        await route.abort();
        return;
      }
      await route.continue();
    });
  }
  await page.goto("/panorama/samples");
  // 共享数据库里还有其它测试/代理造的数据：用搜索把断言收敛到本次种子，
  // 否则「首屏 24 条」可能被别人的新数据挤出视野（跨任务并发时的真实风险）。
  const filterAppliedAt = Date.now();
  if (query) {
    await page.getByLabel("搜索样品").fill(query);
    // 搜索有 300ms 防抖：等到「当前所有卡片都包含关键词」再继续，
    // 否则截图/断言可能落在旧列表上（共享库里通常还有几十条无关数据）。
    await page.waitForFunction(
      ({ selector, keyword }) => {
        const cards = [...document.querySelectorAll(selector)];
        const needle = keyword.toLowerCase();
        return (
          cards.length > 0 &&
          cards.every((card) => (card.textContent ?? "").toLowerCase().includes(needle))
        );
      },
      { selector: GALLERY_CARDS, keyword: query },
    );
  }
  await page.locator(GALLERY_CARDS).first().waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ selector, min }) => document.querySelectorAll(selector).length >= min,
    { selector: GALLERY_CARDS, min: minCards },
  );
  // 等首屏图片真正解码完：否则截图是空框，请求断言也可能漏记。
  await page.waitForFunction((selector) => {
    const images = [...document.querySelectorAll(`${selector} img`)] as HTMLImageElement[];
    return images.every((image) => image.complete);
  }, GALLERY_CARDS);
  return { filterAppliedAt };
}

export async function openSample(page: Page, sample: { code: string }): Promise<void> {
  await openGallery(page, sample.code, 1);
  const card = page.locator(GALLERY_CARDS).filter({ hasText: sample.code }).first();
  await card.locator("button").first().click();
  await page.locator("aside").getByText("成本底线").waitFor({ state: "visible" });
}

/** 页面上所有图片请求 + 发生时间（用于「只请求缩略图」断言，需排除筛选前的请求）。 */
export function trackMediaRequests(page: Page): { url: string; at: number }[] {
  const requests: { url: string; at: number }[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(MEDIA_BASE_URL)) {
      requests.push({ url: request.url(), at: Date.now() });
    }
  });
  return requests;
}

export async function noHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const scrolling = document.scrollingElement;
    if (!scrolling) return null;
    const offenders: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.right > scrolling.clientWidth + 0.5) {
        offenders.push(
          `${element.tagName.toLowerCase()} right=${Math.round(rect.right)} w=${Math.round(rect.width)} ` +
            `cls="${String(element.className).slice(0, 80)}" text="${(element.textContent ?? "").trim().slice(0, 24)}"`,
        );
      }
    }
    return {
      scrollWidth: scrolling.scrollWidth,
      clientWidth: scrolling.clientWidth,
      offenders: offenders.slice(0, 12),
    };
  });
  if (!metrics) throw new Error("拿不到 scrollingElement");
  if (metrics.scrollWidth > metrics.clientWidth) {
    throw new Error(
      `出现横向滚动：scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}\n` +
        `越界元素：\n${metrics.offenders.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
}

export async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, `${testInfo.project.name}-${name}.png`),
    fullPage: true,
  });
}
