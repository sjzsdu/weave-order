import { expect, test } from "../../support/test";
import { API_URL, WEB_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { screenshot } from "../../support/ui";

/**
 * 客户合并（WAN-214）：详情页入口 → 选目标 → 影响预览 → 确认合并 → 撤销回滚。
 *
 * 后端 preview/merge/undo 链路 + api-client 方法早已就绪，但 web 层零调用。
 * 本用例锁住「两步确认 + 可撤销」的 UI 闭环：无 resource.merge 能力不渲染入口；
 * 撤销后数据回到合并前（两客户仍 AVAILABLE）。
 *
 * 数据只做「两个一次性客户」这一层，合并/撤销用真实页面 + 真实后端，不 mock。
 */
test.describe("客户合并：两步确认 + 可撤销", () => {
  test("owner 走通 预览→合并→撤销；sales 无入口", async ({ page, context, request }, testInfo) => {
    const seed = await readSeed();
    const ownerHeaders = {
      Authorization: `Bearer ${seed.ownerCredential}`,
      "Content-Type": "application/json",
    };
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

    // ── 造一对一次性客户（合并对象，不做成父子依赖） ──
    const sourceResponse = await request.post(`${API_URL}/api/customers`, {
      headers: ownerHeaders,
      data: { code: `E2E-MERGE-SRC-${suffix}`, name: `合并源客户 ${suffix}` },
    });
    expect(sourceResponse.ok(), await sourceResponse.text()).toBe(true);
    const source = (await sourceResponse.json()) as { customer: { id: string; name: string } };

    const targetResponse = await request.post(`${API_URL}/api/customers`, {
      headers: ownerHeaders,
      data: { code: `E2E-MERGE-TGT-${suffix}`, name: `合并目标客户 ${suffix}` },
    });
    expect(targetResponse.ok(), await targetResponse.text()).toBe(true);
    const target = (await targetResponse.json()) as { customer: { id: string; name: string } };

    // ── sales 无 resource.merge：详情页不渲染入口（不是禁用后可见） ──
    // 用 sales 自己可见的客户做检查，否则「看不到 owner 的客户」会假性通过。
    const salesListResponse = await request.get(`${API_URL}/api/customers?limit=1`, {
      headers: {
        Authorization: `Bearer ${seed.salesCredential}`,
        "Content-Type": "application/json",
      },
    });
    expect(salesListResponse.ok()).toBe(true);
    const salesVisible = (await salesListResponse.json()) as {
      customers: { id: string; name: string }[];
    };
    const salesCustomer = salesVisible.customers[0];
    expect(salesCustomer).toBeDefined();
    const salesTargetId = salesCustomer!.id;

    const salesContext = await context.browser()!.newContext({
      viewport: page.viewportSize(),
      baseURL: WEB_URL,
      storageState: {
        cookies: [
          {
            name: "weave_token",
            value: seed.salesCredential,
            domain: "localhost",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax" as const,
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
    await salesPage.goto(`/panorama/customers/${salesTargetId}`);
    // 面板真的渲染了该客户（避免因数据范围问题停在空态）。
    await expect(salesPage.getByText(salesCustomer!.name).first()).toBeVisible();
    await expect(
      salesPage.getByRole("button", { name: "合并到其他客户" }),
    ).toHaveCount(0);
    await salesContext.close();

    // ── owner 详情页：入口出现 ──
    await page.goto(`/panorama/customers/${source.customer.id}`);
    const mergeButton = page.getByRole("button", { name: "合并到其他客户" });
    await expect(mergeButton).toBeVisible();

    // ── 第一步：搜索目标客户（排除源客户自己） ──
    await mergeButton.click();
    const dialog = page.getByRole("dialog");
    const search = dialog.getByPlaceholder("按客户名 / 编号搜索");
    await expect(search).toBeVisible();
    // 搜源客户自己：前端拦掉（结果列表过滤掉自己），停留在搜索态。
    await search.fill(source.customer.name);
    await expect(dialog.getByText("没有匹配的客户")).toBeVisible();
    await screenshot(page, testInfo, "merge-step1-self-excluded");

    // 搜目标客户并选中
    await search.fill(`合并目标客户 ${suffix}`);
    await dialog.getByRole("button", { name: new RegExp(`合并目标客户 ${suffix}`) }).first().click();

    // ── 第二步：影响预览（七项计数 + 有效期） ──
    await expect(dialog.getByText("会转移的数据")).toBeVisible();
    for (const label of ["报价", "订单", "寄样单", "应收", "事项", "联系人", "决策变更"]) {
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(dialog.getByText(/预览有效期至/)).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "确认合并" });
    await expect(confirm).toBeEnabled();
    await screenshot(page, testInfo, "merge-step2-preview");

    // ── 第三步：确认合并 → 结果含撤销窗口 ──
    await confirm.click();
    await expect(dialog.getByText("合并完成")).toBeVisible();
    await expect(dialog.getByText(/撤销窗口截止至/)).toBeVisible();
    await screenshot(page, testInfo, "merge-step3-result");

    // 撤销 → 回到合并前
    await dialog.getByRole("button", { name: "撤销合并" }).click();
    await expect(dialog.getByText("已撤销合并")).toBeVisible();
    await screenshot(page, testInfo, "merge-undo-result");

    // 撤销后后端确认：两客户都还是 AVAILABLE（回滚完整）
    const checkResponse = await request.get(`${API_URL}/api/customers?query=${suffix}&limit=20`, {
      headers: ownerHeaders,
    });
    expect(checkResponse.ok()).toBe(true);
    const found = (await checkResponse.json()) as {
      customers: { id: string; code: string; status: string }[];
    };
    expect(found.customers.map((c) => c.id)).toContain(source.customer.id);
    expect(found.customers.map((c) => c.id)).toContain(target.customer.id);
    const src = found.customers.find((c) => c.id === source.customer.id)!;
    expect(src.status).toBe("AVAILABLE");
  });
});