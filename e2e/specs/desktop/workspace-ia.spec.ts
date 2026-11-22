import { expect, test } from "../../support/test";
import { API_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { noHorizontalScroll } from "../../support/ui";
import type { Page } from "@playwright/test";

/**
 * 造一条「还没结束」的事项，返回它的 id。
 *
 * 为什么不能直接点「最近事项的第一条」：那一条可能是别的用例跑完的已完成事项，
 * 终态（COMPLETED / CLOSED）不允许迁移到 CLOSED，详情页就不会渲染「更多操作」，
 * 按第一条点会随跑批顺序时红时绿。断言必须落在一件自己造的、非终态的事项上。
 */
async function createOpenItem(page: Page): Promise<string> {
  const seed = await readSeed();
  const headers = { Authorization: `Bearer ${seed.ownerCredential}` };

  const customersResponse = await page.request.get(
    `${API_URL}/api/customers?query=${encodeURIComponent(seed.persona.customerCode)}&limit=50`,
    { headers },
  );
  expect(customersResponse.ok(), `查客户失败：HTTP ${customersResponse.status()}`).toBe(true);
  const customersBody = (await customersResponse.json()) as {
    customers: { id: string; code: string }[];
  };
  const customer = customersBody.customers.find((row) => row.code === seed.persona.customerCode);
  if (!customer) throw new Error(`seed 里没有客户 ${seed.persona.customerCode}`);
  const sample = seed.fabricSamples[0];
  if (!sample) throw new Error("seed 里没有可用的样品");

  const createResponse = await page.request.post(`${API_URL}/api/items`, {
    headers,
    data: {
      customerId: customer.id,
      sampleId: sample.id,
      // 数量带上轮次：同客户+样品+数量会「续接」已有事项，用新数量保证是新建的一条。
      quantity: { value: 1000 + (Date.now() % 1_000_000), unit: "meter" },
    },
  });
  expect(createResponse.ok(), `建事项失败：HTTP ${createResponse.status()}`).toBe(true);
  const created = (await createResponse.json()) as {
    outcome: string;
    item: { id: string; status: string } | null;
    message: string;
  };
  if (!created.item) {
    throw new Error(`建事项没有落库：${created.outcome} / ${created.message}`);
  }
  expect(created.item.status, "新建的事项必须是未结束状态，否则不会渲染「更多操作」").not.toBe(
    "COMPLETED",
  );
  expect(created.item.status).not.toBe("CLOSED");
  return created.item.id;
}

/**
 * WAN-196 信息架构重组验收：
 * 新首页是事项，资源承载客户/样品/模板，设置承载审计；旧路由 307 映射不 404；
 * 灰度关闭（worktree cookie `weave_ia=legacy`）后旧界面完整回来。
 */
test.describe("工作台信息架构（新 IA）", () => {
  test("登录后第一屏是事项，/today 307 映射不 404", async ({ page }) => {
    const itemsRequest = page.waitForResponse(
      (response) => response.url().includes("/api/items?") && response.ok(),
    );
    await page.goto("/today");
    await expect(page).toHaveURL(/\/items\?filter=recent$/);
    await itemsRequest;
    await expect(page.getByRole("heading", { name: "最近在办的事" })).toBeVisible();
    await expect(page.getByRole("link", { name: "最近事项" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("两个过滤都打同一条 /api/items，待我处理带 filter=mine", async ({ page }) => {
    await page.goto("/items?filter=recent");
    await expect(page.getByRole("heading", { name: "最近在办的事" })).toBeVisible();

    const mineRequest = page.waitForResponse(
      (response) =>
        response.url().includes("/api/items?filter=mine") ||
        (response.url().includes("/api/items?") && response.url().includes("filter=mine")),
    );
    await page.getByRole("link", { name: "待我处理" }).click();
    await expect(page).toHaveURL(/\/items\?filter=mine$/);
    const response = await mineRequest;
    expect(response.ok()).toBe(true);
  });

  test("一级导航是工作台/事项/资源/设置，审批不再出现", async ({ page }) => {
    await page.goto("/items?filter=recent");
    const nav = page.getByRole("navigation", { name: "桌面窗口" });
    await expect(nav.getByRole("link", { name: "工作台" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "事项" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "资源" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "设置" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "审批" })).toHaveCount(0);
  });

  test("工作台有独立入口，不再只能从新建事项的深链进入", async ({ page }) => {
    await page.goto("/items?filter=recent");
    // 等事项列表真的挂载再点顶栏链接。
    //
    // 顶栏是服务端渲染的：goto 一回来「工作台」就可见、可点，但那时 React 还没
    // hydrate。Next 的全局点击代理会 preventDefault 掉这次点击并发起路由跳转，
    // 可跳转提交不了 —— URL 不变，链接像坏了一样（e2e-nightly 上偶发，2026-11-22 实测）。
    // 事项列表是挂载后才渲染的，看到标题就说明 hydrate 完了，链接的 onClick 已就位。
    await expect(page.getByRole("heading", { name: "最近在办的事" })).toBeVisible();
    await page
      .getByRole("navigation", { name: "桌面窗口" })
      .getByRole("link", { name: "工作台" })
      .click();
    await expect(page).toHaveURL(/\/workbench$/);
    await expect(page.getByText("工作台", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /小织|今天|件等你决定/ })).toBeVisible();
  });

  test("新建事项打开空白输入框，不把指导语当成用户内容", async ({ page }) => {
    await page.goto("/items?filter=recent");
    await page.getByRole("link", { name: "新建事项" }).click();
    // 统一输入页就是 /inbound：以前这里回退到 /today，只是因为统一输入页还没上线，
    // 现在「新建事项」直接去它，空状态只打开输入位置（compose=1）。
    await expect(page).toHaveURL(/\/inbound\?compose=1$/);
    const composer = page.locator("textarea");
    await expect(composer).toBeVisible();
    // 指导语只当提示，不进输入框；光标已经在框里，可以直接打字。
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();
  });

  test("事项详情面包屑不再把「资源」当父级", async ({ page }) => {
    await page.goto("/items?filter=recent");
    const firstItem = page.getByRole("listitem").getByRole("link").first();
    await expect(firstItem).toBeVisible();
    await firstItem.click();
    const crumbs = page.getByRole("navigation", { name: "面包屑" });
    await expect(crumbs.getByRole("link", { name: "事项" })).toBeVisible();
    await expect(crumbs.getByRole("link", { name: "资源" })).toHaveCount(0);
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText("事项详情");
  });

  test("关闭事项必须二次确认，不直接执行", async ({ page }) => {
    const itemId = await createOpenItem(page);
    await page.goto(`/items/${itemId}`);
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("button", { name: "关闭事项（不可撤销）" }).click();
    await expect(page.getByText("关闭后不能再改状态，确定关闭？")).toBeVisible();
    // 只走到确认层，不执行不可逆动作。
    await page.getByRole("button", { name: "先不关" }).click();
    await expect(page.getByText("关闭后不能再改状态，确定关闭？")).toHaveCount(0);
  });

  test("/panorama 307 到资源，客户/样品/模板三块都在", async ({ page }) => {
    await page.goto("/panorama");
    await expect(page).toHaveURL(/\/resources$/);
    await expect(page.getByRole("heading", { name: "客户、样品与模板" })).toBeVisible();
    for (const label of ["客户", "样品", "模板"]) {
      await expect(page.getByRole("link", { name: new RegExp(`^${label}`) }).first()).toBeVisible();
    }
    // 旧业务深链不迁移。
    await page.goto("/panorama/customers");
    await expect(page).toHaveURL(/\/panorama\/customers/);
  });

  test("直接访问 /approvals 不展示审批队列", async ({ page }) => {
    await page.goto("/approvals");
    await expect(page.getByText("审批已取消，事项里跟进")).toBeVisible();
    await expect(page.getByText("待批草稿")).toHaveCount(0);
  });

  test("375 宽：底部导航四项、触控目标 ≥44px、无横向滚动", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/items?filter=recent");
    const bottomNav = page.getByRole("navigation", { name: "移动端主导航" });
    await expect(bottomNav).toBeVisible();
    const links = bottomNav.getByRole("link");
    await expect(links).toHaveCount(4);
    const boxes = await links.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.textContent?.trim(), height: rect.height, width: rect.width };
      }),
    );
    expect(boxes.map((box) => box.label)).toEqual(["工作台", "事项", "资源", "设置"]);
    for (const box of boxes) {
      expect(box.height, `${box.label} 触控高度`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${box.label} 触控宽度`).toBeGreaterThanOrEqual(44);
    }
    await noHorizontalScroll(page);
  });
});

test.describe("工作台信息架构（灰度回旧）", () => {
  test("worktree cookie weave_ia=legacy：/today 仍渲染旧工作台，导航回到四项", async ({
    context,
    page,
  }) => {
    await context.addCookies([
      {
        name: "weave_ia",
        value: "legacy",
        domain: "localhost",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/today");
    // 没有被 307 到 /items。
    await expect(page).toHaveURL(/\/today$/);
    const nav = page.getByRole("navigation", { name: "桌面窗口" });
    await expect(nav.getByRole("link", { name: "工作台" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "业务" })).toBeVisible();

    await page.goto("/panorama");
    await expect(page).toHaveURL(/\/panorama$/);
    await expect(page.getByRole("heading", { name: "全局一眼看完" })).toBeVisible();
  });
});
