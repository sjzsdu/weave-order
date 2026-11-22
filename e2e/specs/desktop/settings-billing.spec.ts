import { expect, test } from "../../support/test";

/**
 * WAN-204 收尾：用量与订阅页的两处文案。
 * 1. 未配置支持邮箱时，「需要变更请」不能悬空；
 * 2. 额度数字必须保持一致的空格口径。
 */
test("用量与订阅的额度与变更文案完整", async ({ page }) => {
  await page.goto("/settings?section=billing");
  await expect(page.getByRole("heading", { name: "本月 AI 额度（credits）" })).toBeVisible();

  const quota = page.locator("section", { hasText: "本月 AI 额度" });
  await expect(quota).toContainText(/\d[\d,]* \/ (不限|[\d,]+) credits/);

  const subscription = page.locator("section", { hasText: "订阅" });
  await expect(subscription).toContainText(
    /需要变更请\s*(联系对接人|联系你的对接人或平台管理员)\s*。/,
  );
});
