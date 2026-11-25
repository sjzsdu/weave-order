import { expect, test } from "../../support/test";
import { readSeed } from "../../support/seed";
import { GALLERY_CARDS, openGallery, screenshot } from "../../support/ui";

/**
 * WAN-220 寄样进度：样品图墙与样品抽屉都要说清「寄给过谁、到哪了」。
 *
 * 断言只看库里真的寄样单：种子里那台样品有一张草稿，另一个样品一张都没有；
 * 「读取失败」用请求拦截构造，页面必须说失败，不能假装没有寄样单。
 */
test.describe("样品寄样进度", () => {
  test("图墙徽标、抽屉记录、空态与失败态都只说事实", async ({ page }, testInfo) => {
    const seed = await readSeed();
    const { sample, shipment } = seed.shipmentFixture;
    const noShipment = seed.carouselSample;

    // 一张真实草稿：图上要出现徽标，顶部汇总要和库里这张单对得上。
    await openGallery(page, sample.code, 1);
    await expect(page.locator(GALLERY_CARDS).filter({ hasText: sample.code })).toHaveCount(1);
    const badge = page.locator('[data-testid="sample-shipment-badge"]');
    await expect(badge).toHaveCount(1);
    await expect(badge).toContainText("草稿待确认");
    // 徽标只写状态，不替智能体邀功（历史上这里写过「小织正在追踪」）。
    expect(await badge.innerText()).not.toMatch(/小织|智能体|正在追踪/);

    const summary = page.locator('[data-testid="sample-shipment-summary"]');
    await expect(summary).toContainText("1 个寄样单还没结束");
    await expect(summary).toContainText("1 草稿待确认");
    await expect(summary).not.toContainText("小织");
    await screenshot(page, testInfo, "shipment-wall-badge");

    // 抽屉里列出这张单：客户、状态、来源时间；未填运单就直说未填运单。
    const drawer = page.locator("aside");
    await page
      .locator(GALLERY_CARDS)
      .filter({ hasText: sample.code })
      .first()
      .locator("button")
      .first()
      .click();
    await drawer.getByText("寄样记录", { exact: true }).waitFor({ state: "visible" });
    const history = drawer.locator('[data-testid="sample-shipment-history"]');
    await expect(history).toContainText("1 张寄样单");
    await expect(history).toContainText(shipment.customerName);
    await expect(history).toContainText("草稿待确认");
    await expect(history).toContainText("未填运单");
    await expect(history).not.toContainText("小织");
    await history.scrollIntoViewIfNeeded();
    await screenshot(page, testInfo, "shipment-drawer-history");
    await drawer.getByRole("button", { name: "关闭" }).click();

    // 没寄过的样品：一句事实 + 一个下一步，而不是空白或「暂无数据」。
    await page.getByLabel("搜索样品").fill(noShipment.code);
    await page.waitForFunction(
      ({ selector, code }) => {
        const cards = [...document.querySelectorAll(selector)];
        return cards.length > 0 && cards.every((card) => (card.textContent ?? "").includes(code));
      },
      { selector: GALLERY_CARDS, code: noShipment.code },
    );
    await expect(page.locator('[data-testid="sample-shipment-badge"]')).toHaveCount(0);
    await expect(summary).toContainText("没有未结的寄样单");
    await page
      .locator(GALLERY_CARDS)
      .filter({ hasText: noShipment.code })
      .first()
      .locator("button")
      .first()
      .click();
    await drawer.getByText("寄样记录", { exact: true }).waitFor({ state: "visible" });
    await expect(history).toContainText("这个样品还没有寄给过客户");
    await expect(history).toContainText("建寄样单");
    await history.scrollIntoViewIfNeeded();
    await screenshot(page, testInfo, "shipment-drawer-empty");
    await drawer.getByRole("button", { name: "关闭" }).click();

    // 读取失败：明确说失败并允许刷新重试，不显示 0 张也不显示「没有寄样单」。
    await page.route("**/api/sample-shipments*", (route) => route.abort());
    await openGallery(page, sample.code, 1);
    await expect(summary).toContainText("寄样进度读取失败");
    await expect(page.locator('[data-testid="sample-shipment-badge"]')).toHaveCount(0);
    await screenshot(page, testInfo, "shipment-wall-error");
    await page.unroute("**/api/sample-shipments*");
  });
});
