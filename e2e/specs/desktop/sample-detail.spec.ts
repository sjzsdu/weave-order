import { expect, test } from "../../support/test";
import { API_URL, AUTH, WEB_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { openGallery, openSample, screenshot } from "../../support/ui";

/**
 * 样品详情：大图轮播顺序、规格表、成本底线按角色裁剪。
 * 成本底线断言不靠前端文案猜：先拿服务端 API 的返回值，再对页面。
 */
test.describe("样品详情抽屉", () => {
  test("轮播按 sortOrder、规格表可见、成本底线按角色裁剪", async ({ page, request }, testInfo) => {
    const seed = await readSeed();
    const sample = seed.carouselSample;
    const priced = seed.fabricSamples[0];
    if (!priced) throw new Error("缺少带成本底线的种子样品");

    // 服务端顺序就是 sortOrder 顺序（种子先传 sortOrder=2、后传 sortOrder=1）。
    expect(sample.images).toHaveLength(2);
    expect(sample.images[0]?.url).not.toBe(sample.images[1]?.url);

    await openSample(page, priced);

    const drawer = page.locator("aside");
    // 规格表逐项可见。
    for (const label of ["编码", "品名", "成分", "品类", "克重", "单位", "状态", "图片"]) {
      await expect(drawer.getByText(label, { exact: true })).toBeVisible();
    }
    const codeRow = drawer.locator("tr").filter({ hasText: "编码" }).locator("td").nth(1);
    await expect(codeRow).toHaveText(priced.code);

    // OWNER 能看到成本底线（种子 1200 分 = ¥12.00）。
    const costRow = drawer.locator("tr").filter({ hasText: "成本底线" }).locator("td").nth(1);
    await expect(costRow).toContainText("12.00");
    await expect(costRow).not.toHaveText("—");
    await costRow.scrollIntoViewIfNeeded();
    await screenshot(page, testInfo, "sample-detail-owner");

    // 双图样品：大图顺序必须等于服务端 images 顺序，而不是上传顺序。
    await drawer.getByRole("button", { name: "关闭" }).click();
    await openSample(page, sample);
    const first = drawer.locator('img[alt*="第 1 张"]');
    // WAN-125：大图优先用派生的 `_640.webp`，未就绪才回退原图。
    const firstSrc = sample.images[0]!.detailUrl ?? sample.images[0]!.url;
    await expect(first).toHaveAttribute("src", new RegExp(escapeRegExp(firstSrc)));
    const thumbs = drawer.locator('button:has(img[alt*="缩略图"])');
    await expect(thumbs).toHaveCount(2);
    await thumbs.nth(1).click();
    const secondSrc = sample.images[1]!.detailUrl ?? sample.images[1]!.url;
    await expect(drawer.locator('img[alt*="第 2 张"]')).toHaveAttribute(
      "src",
      new RegExp(escapeRegExp(secondSrc)),
    );
    await screenshot(page, testInfo, "sample-detail-carousel");

    // 同一份数据，SALES 登录看不到成本底线（服务端裁剪，前端只渲染 null）。
    const salesResponse = await request.get(`${API_URL}/api/samples/${priced.id}`, {
      headers: { Authorization: `Bearer ${seed.salesCredential}` },
    });
    expect(salesResponse.ok()).toBe(true);
    const salesSample = (await salesResponse.json()) as { sample: { costFloor: unknown } };
    expect(salesSample.sample.costFloor).toBeNull();

    const salesContext = await page
      .context()
      .browser()!
      .newContext({
        viewport: page.viewportSize(),
        baseURL: WEB_URL,
        storageState: {
          cookies: [
            {
              name: "weave_token",
              value: AUTH.sales,
              domain: "localhost",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: false,
              sameSite: "Lax",
            },
            ...(seed.salesSid
              ? [
                  {
                    name: "weave_sid",
                    value: seed.salesSid,
                    domain: "localhost",
                    path: "/",
                    expires: -1,
                    httpOnly: true,
                    secure: false,
                    sameSite: "Lax" as const,
                  },
                ]
              : []),
          ],
          origins: [],
        },
      });
    const salesPage = await salesContext.newPage();
    await openGallery(salesPage);
    await openSample(salesPage, priced);
    const salesDrawer = salesPage.locator("aside");
    const salesCostRow = salesDrawer
      .locator("tr")
      .filter({ hasText: "成本底线" })
      .locator("td")
      .nth(1);
    await expect(salesCostRow).toHaveText("—");
    await expect(salesCostRow).not.toContainText("12.00");
    await salesCostRow.scrollIntoViewIfNeeded();
    await screenshot(salesPage, testInfo, "sample-detail-sales");
    await salesContext.close();
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
