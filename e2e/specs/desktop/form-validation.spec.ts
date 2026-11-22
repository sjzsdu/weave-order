import { expect, test } from "../../support/test";

/**
 * WAN-204 第三轮：手工录入表单的必填校验。
 * 空提交必须留在弹窗里、就地报错、把焦点带回缺失字段，不能静默关闭。
 */
test.describe("新建表单必填校验", () => {
  test("新建样品空提交：不关闭弹窗，品名就地报错并获得焦点", async ({ page }) => {
    await page.goto("/panorama/samples?new=1");
    await expect(page.getByRole("heading", { name: "新建样品" })).toBeVisible();

    const name = page.locator("#sample-name");
    await expect(name).toHaveAttribute("aria-required", "true");
    await page.getByRole("button", { name: "保存" }).click();

    await expect(page.getByRole("heading", { name: "新建样品" })).toBeVisible();
    await expect(page.locator("#sample-name-error")).toHaveText("品名必填");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toBeFocused();

    // 补上品名后错误立即消失，再取消，不留下测试数据。
    await name.fill("E2E 校验样品");
    await expect(page.locator("#sample-name-error")).toHaveCount(0);
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("heading", { name: "新建样品" })).toHaveCount(0);
  });

  test("新建客户空提交：不关闭抽屉，客户名与联系人分别报错", async ({ page }) => {
    await page.goto("/panorama/customers?new=1");
    await expect(page.getByRole("heading", { name: "新建客户" })).toBeVisible();

    const name = page.locator("#customer-name");
    await expect(name).toHaveAttribute("aria-required", "true");
    await page.getByRole("button", { name: "建客户", exact: true }).click();

    await expect(page.getByRole("heading", { name: "新建客户" })).toBeVisible();
    await expect(page.locator("#customer-name-error")).toHaveText("客户名称必填");
    await expect(page.locator("#customer-contact-name-error")).toHaveText(
      "请先填第一位联系人的姓名",
    );
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");

    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("heading", { name: "新建客户" })).toHaveCount(0);
  });
});
