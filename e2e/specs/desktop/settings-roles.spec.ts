import { expect, test } from "../../support/test";

/**
 * WAN-204 收尾轮：邀请角色下拉与能力矩阵必须使用同一套中文角色名。
 * 「经理 / 主管」两套叫法会让被邀请人找不到自己的权限边界。
 */
test("成员邀请的角色名与能力矩阵一致", async ({ page }) => {
  await page.goto("/settings?section=members");
  await expect(page.getByRole("heading", { name: "能力矩阵（只读）" })).toBeVisible();

  const roleSelect = page.getByLabel("角色");
  const inviteLabels = await roleSelect.locator("option").allTextContents();

  const matrix = page.locator("section", { hasText: "能力矩阵（只读）" });
  const matrixHeaders = await matrix.locator("thead th").allTextContents();

  expect(inviteLabels.length).toBeGreaterThan(0);
  expect(inviteLabels).toContain("经理");
  expect(inviteLabels).not.toContain("主管");
  for (const label of inviteLabels) {
    expect(matrixHeaders).toContain(label);
  }
});
