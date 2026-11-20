import { expect, test } from "../../support/test";
import { API_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { screenshotViewport } from "../../support/ui";

/**
 * WAN-136 的两个验收场景：
 *  1. ⌘⇧I 切 persona 后，界面随角色能力变化，且路由不被整页刷新掉；
 *  2. 经理（MANAGER/TEAM）能看到业务员（SALES/OWN）名下的客户。
 *
 * 断言尽量落在「服务端真实会话」上：切完角色后直接拿 weave_sid 调 API，
 * 确认 membership 的 role/dataScope 与数据可见性，而不是只看界面文案。
 */

async function openPersonaBar(page: import("@playwright/test").Page): Promise<void> {
  // 先等身份条挂载：goto 后立刻按键可能落在 React hydrate 之前，监听还没绑上。
  await page.getByRole("button", { name: /身份切换/ }).waitFor({ state: "visible" });
  await page.keyboard.press("Control+Shift+I");
  await expect(page.getByRole("listbox", { name: "演示身份" })).toBeVisible();
}

async function switchPersona(
  page: import("@playwright/test").Page,
  roleLabel: string,
): Promise<void> {
  const option = page
    .getByRole("listbox", { name: "演示身份" })
    .getByRole("option", { name: new RegExp(roleLabel) });
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/dev/session")),
    option.click(),
  ]);
  await expect(page.getByRole("button", { name: new RegExp(`当前：${roleLabel}`) })).toBeVisible();
}

async function sessionSid(page: import("@playwright/test").Page): Promise<string> {
  const cookies = await page.context().cookies();
  const sid = cookies.find((cookie) => cookie.name === "weave_sid")?.value;
  if (!sid) throw new Error("切换 persona 后没有 weave_sid");
  return sid;
}

async function apiGet<T>(
  page: import("@playwright/test").Page,
  path: string,
  sid: string,
): Promise<T> {
  const response = await page.request.get(`${API_URL}${path}`, {
    headers: { cookie: `weave_sid=${sid}` },
  });
  expect(response.ok(), `${path} → HTTP ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

test.describe("dev persona 切换", () => {
  /*
   * persona 切换会销毁旧 sid（与真实切换租户同一安全策略）。e2e 的其它 spec 共用
   * globalSetup 建的 owner sid，所以这里先清掉它、再用 dev 端点建立本用例专属会话，
   * 避免「A 用例切了身份，B 用例的共享 sid 就过期」。
   * weave_token 必须保留：e2e 的 web 是 next start（productionLike），middleware 要它放行。
   */
  test.beforeEach(async ({ context, page }) => {
    await context.clearCookies({ name: "weave_sid" });
    const response = await page.request.post(`${API_URL}/api/dev/session`, {
      data: { personaKey: "owner" },
    });
    expect(response.ok(), `建立 persona 测试会话失败：HTTP ${response.status()}`).toBe(true);
  });

  test("⌘⇧I 切到财务：能力驱动界面变化，路由保持不动", async ({ page }, testInfo) => {
    await page.goto("/resources");
    await expect(page.getByRole("link", { name: /按交期看订单漏斗/ })).toBeVisible();

    await openPersonaBar(page);
    await screenshotViewport(page, testInfo, "persona-bar-owner");
    await switchPersona(page, "财务");

    // 不整页 reload：仍是同一个 /resources，只是能力变了。
    await expect(page).toHaveURL(/\/resources$/);
    // finance 没有 panorama.orders.view，订单漏斗入口消失。
    await expect(page.getByRole("link", { name: /按交期看订单漏斗/ })).toHaveCount(0);
    // 应收入口仍在：变化来自能力表，而不是页面挂了。
    await expect(page.getByRole("link", { name: /逾期、本月到期、已结清/ })).toBeVisible();
    await screenshotViewport(page, testInfo, "persona-bar-finance");
  });

  test("经理能看到业务员名下的客户（同 team）", async ({ page }, testInfo) => {
    const seed = await readSeed();
    expect(seed.persona.managerTeamId).toBe(seed.persona.salesTeamId);
    expect(seed.persona.managerTeamId).not.toBeNull();

    await page.goto("/resources");
    await openPersonaBar(page);
    await switchPersona(page, "销售");

    const salesSid = await sessionSid(page);
    const salesMe = await apiGet<{
      membership: { role: string; dataScope: string };
    }>(page, "/api/auth/me", salesSid);
    expect(salesMe.membership).toMatchObject({ role: "SALES", dataScope: "OWN" });

    const salesCustomers = await apiGet<{ customers: { code: string }[] }>(
      page,
      "/api/auth/customers?limit=100",
      salesSid,
    );
    expect(salesCustomers.customers.map((customer) => customer.code)).toContain(
      seed.persona.customerCode,
    );

    await openPersonaBar(page);
    await switchPersona(page, "经理");

    const managerSid = await sessionSid(page);
    expect(managerSid).not.toBe(salesSid);
    const managerMe = await apiGet<{
      membership: { role: string; dataScope: string };
    }>(page, "/api/auth/me", managerSid);
    expect(managerMe.membership).toMatchObject({ role: "MANAGER", dataScope: "TEAM" });

    // 同一条客户在经理的 TEAM 范围里仍然可见（业务员名下，不是经理自己的）。
    const managerCustomers = await apiGet<{ customers: { code: string }[] }>(
      page,
      "/api/auth/customers?limit=100",
      managerSid,
    );
    expect(managerCustomers.customers.map((customer) => customer.code)).toContain(
      seed.persona.customerCode,
    );

    // UI 也随会话重拉：搜索夹具客户编号能看到它。
    await page.goto(`/panorama/customers?q=${encodeURIComponent(seed.persona.customerCode)}`);
    await expect(page.getByText(seed.persona.customerCode).first()).toBeVisible();
    await screenshotViewport(page, testInfo, "persona-manager-customers");
  });
});
