import {
  ItemCreateResult,
  ItemDetail,
  QuoteDetail,
  AuditLogListResponse,
} from "../../../packages/schema/src";
import { expect, test } from "../../support/test";
import { API_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { noHorizontalScroll, screenshot } from "../../support/ui";

test.describe("事项决定面：状态撤销与报价依据", () => {
  let itemId: string;
  let quoteId: string;
  let original: { status: string; currentStage: string | null; nextAction: string | null };
  let headers: Record<string, string>;

  test.beforeEach(async ({ request }) => {
    const seed = await readSeed();
    headers = { Authorization: `Bearer ${seed.ownerCredential}` };
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const customerResponse = await request.post(`${API_URL}/api/customers`, {
      headers,
      data: { code: `DECIDE-C-${suffix}`, name: "决定面测试客户" },
    });
    expect(customerResponse.ok(), await customerResponse.text()).toBeTruthy();
    const { customer } = (await customerResponse.json()) as { customer: { id: string } };
    const sampleResponse = await request.post(`${API_URL}/api/samples`, {
      headers,
      data: {
        code: `DECIDE-S-${suffix}`,
        name: "全棉灰色面料",
        unit: "meter",
        status: "ACTIVE",
        costFloor: { amount: 1000, currency: "CNY" },
      },
    });
    expect(sampleResponse.ok(), await sampleResponse.text()).toBeTruthy();
    const { sample } = (await sampleResponse.json()) as { sample: { id: string } };
    const itemResponse = await request.post(`${API_URL}/api/items`, {
      headers,
      data: {
        customerId: customer.id,
        sampleId: sample.id,
        quantity: { value: 10, unit: "meter" },
        currentStage: "正在核对价格",
        nextAction: "确认最终价格",
      },
    });
    expect(itemResponse.ok(), await itemResponse.text()).toBeTruthy();
    const item = ItemCreateResult.parse(await itemResponse.json()).item!;
    itemId = item.id;
    original = {
      status: item.status,
      currentStage: item.currentStage,
      nextAction: item.nextAction,
    };
    const draftResponse = await request.post(`${API_URL}/api/items/${itemId}/quotes`, {
      headers,
      data: { unitPrice: { amount: 1500, currency: "CNY" } },
    });
    expect(draftResponse.ok(), await draftResponse.text()).toBeTruthy();
    const draft = QuoteDetail.parse(await draftResponse.json());
    quoteId = draft.draft.id;
    const confirmation = await request.post(`${API_URL}/api/quotes/${quoteId}/confirm`, {
      headers,
      data: { baseVersion: draft.version, idempotencyKey: `decide-${suffix}` },
    });
    expect(confirmation.ok(), await confirmation.text()).toBeTruthy();
  });

  test("真实迁移→撤销恢复三字段，审计双写；提示满 5 秒消失", async ({
    page,
    request,
  }, testInfo) => {
    await page.goto(`/items/${itemId}`);
    await expect(page.getByRole("heading", { name: "已确认报价的定价依据" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "33.3%" })).toBeVisible();
    await page.getByRole("button", { name: "等我补资料" }).click();
    const undo = page.getByRole("button", { name: "撤销", exact: true });
    await expect(undo).toBeVisible();
    await screenshot(page, testInfo, "item-undo");
    await undo.click();
    await expect(page.getByRole("button", { name: "等我补资料" })).toBeVisible();
    await expect(undo).toHaveCount(0);
    const detailResponse = await request.get(`${API_URL}/api/items/${itemId}`, { headers });
    const detail = ItemDetail.parse(await detailResponse.json());
    expect(detail.item).toMatchObject(original);
    const auditResponse = await request.get(`${API_URL}/api/audit/log?entityType=item&limit=100`, {
      headers,
    });
    expect(auditResponse.ok()).toBeTruthy();
    const audit = AuditLogListResponse.parse(await auditResponse.json());
    const actions = audit.items
      .filter((row: { entityId: string }) => row.entityId === itemId)
      .map((row: { action: string }) => row.action);
    expect(actions.filter((action: string) => action === "ITEM_STATUS_CHANGED")).toHaveLength(1);
    expect(actions.filter((action: string) => action === "ITEM_STATUS_REVERTED")).toHaveLength(1);
    await page.clock.install();
    await page.getByRole("button", { name: "等我决定" }).click();
    await expect(undo).toBeVisible();
    await page.clock.fastForward(5000);
    await expect(undo).toHaveCount(0);
    await page.getByRole("button", { name: "回到处理中" }).click();
    await expect(page.getByRole("button", { name: "等我补资料" })).toBeVisible();
  });

  test("依据请求失败不显示区块，标记完成仍能成功且终态无撤销", async ({ page }) => {
    await page.route(`**/api/quotes/${quoteId}/basis`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "UNAVAILABLE", message: "依据服务暂不可用" }),
      }),
    );
    await page.goto(`/items/${itemId}`);
    await expect(page.getByRole("button", { name: "标记完成" })).toBeEnabled();
    await expect(page.getByRole("heading", { name: "已确认报价的定价依据" })).toHaveCount(0);
    await expect(page.getByText("依据服务暂不可用")).toHaveCount(0);
    await page.getByRole("button", { name: "标记完成" }).click();
    await expect(page.getByText("事项已结束，状态与结果保留可查。")).toBeVisible();
    await expect(page.getByRole("button", { name: "撤销", exact: true })).toHaveCount(0);
  });

  test("六状态截图：正常、空、加载、错误、无权限、长文本窄屏", async ({
    page,
    request,
  }, testInfo) => {
    const response = await request.get(`${API_URL}/api/items/${itemId}`, { headers });
    const detail = ItemDetail.parse(await response.json());
    const active = {
      ...detail,
      item: { ...detail.item, ...original },
      allowedTransitions: ["WAITING_INPUT", "WAITING_DECISION", "COMPLETED", "CLOSED"],
    };
    const path = `**/api/items/${itemId}`;
    await page.route(path, (route) => route.fulfill({ json: active }));
    await page.goto(`/items/${itemId}`);
    await expect(page.getByRole("heading", { name: "已确认报价的定价依据" })).toBeVisible();
    await screenshot(page, testInfo, "item-default");
    await page.route(`**/api/items/${itemId}/quotes`, (route) =>
      route.fulfill({ json: { quotes: [] } }),
    );
    await page.reload();
    await expect(page.getByRole("button", { name: "发起报价" })).toBeVisible();
    await screenshot(page, testInfo, "item-empty");
    await page.unroute(path);
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(path, async (route) => {
      await pending;
      await route.fulfill({ json: active });
    });
    await page.reload();
    await expect(page.getByText("正在读取事项…")).toBeVisible();
    await screenshot(page, testInfo, "item-loading");
    release!();
    await expect(page.getByRole("button", { name: "标记完成" })).toBeVisible();
    for (const [name, status, message] of [
      ["error", 500, "读取失败"],
      ["forbidden", 403, "没有访问该事项的权限"],
    ] as const) {
      await page.unroute(path);
      await page.route(path, (route) =>
        route.fulfill({ status, json: { code: "PERMISSION_DENIED", message } }),
      );
      await page.reload();
      await expect(page.getByText("找不到这个事项")).toBeVisible();
      await screenshot(page, testInfo, `item-${name}`);
    }
    await page.unroute(path);
    await page.unroute(`**/api/items/${itemId}/quotes`);
    await page.route(path, (route) =>
      route.fulfill({
        json: {
          ...active,
          customer: { ...active.customer, name: "超长客户名称".repeat(25) },
          sample: { ...active.sample, name: "超长面料样品名称".repeat(25) },
        },
      }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "已确认报价的定价依据" })).toBeVisible();
    await noHorizontalScroll(page);
    await screenshot(page, testInfo, "item-narrow-long");
  });
});
