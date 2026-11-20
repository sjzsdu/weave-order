import { expect, test } from "../../support/test";
import { API_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { screenshot } from "../../support/ui";

/**
 * 旅程 A（WAN-197）：客户和面料已就位 → 发起报价 → 看依据 → 改价 → 确认 → 复制
 * → 事项完成。全程没有审批环节；确认两次只产生一份结果。
 *
 * 数据准备只做「客户 + 事项」这一层（UI 没有独立建客户表单），
 * 报价、改价、确认、复制、完成全部走真实页面。
 */
test.describe("旅程 A：事项内报价闭环", () => {
  test("报价 → 依据 → 改价 → 确认 → 复制 → 完成，且重复确认幂等", async ({
    page,
    request,
    context,
  }, testInfo) => {
    const seed = await readSeed();
    const sample = seed.fabricSamples[0];
    if (!sample) throw new Error("缺少 E2E 样品种子（需要 fabricSamples[0]）");

    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const headers = {
      Authorization: `Bearer ${seed.ownerCredential}`,
      "Content-Type": "application/json",
    };
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

    const customerResponse = await request.post(`${API_URL}/api/customers`, {
      headers,
      data: { code: `E2E-JA-${suffix}`, name: `旅程客户 ${suffix}` },
    });
    expect(customerResponse.ok(), await customerResponse.text()).toBe(true);
    const customer = (await customerResponse.json()) as { customer: { id: string; name: string } };

    const itemResponse = await request.post(`${API_URL}/api/items`, {
      headers,
      data: {
        customerId: customer.customer.id,
        sampleId: sample.id,
        quantity: { value: 100, unit: "meter" },
      },
    });
    expect(itemResponse.ok(), await itemResponse.text()).toBe(true);
    const itemBody = (await itemResponse.json()) as {
      outcome: string;
      item: { id: string } | null;
    };
    expect(itemBody.outcome).toBe("CREATED");
    const itemId = itemBody.item!.id;

    // 1. 事项页发起报价：指定单价 18 元（样品成本底线 12 元）。
    await page.goto(`/items/${itemId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(customer.customer.name);
    await page.getByLabel("报价单价（元）").fill("18");
    await page.getByRole("button", { name: "发起报价" }).click();
    await page.waitForURL(new RegExp(`/items/${itemId}/quotes/[0-9a-f-]+$`), { timeout: 30_000 });

    await expect(page.getByText("待确认价格")).toBeVisible();
    await expect(page.getByText("确认价格即定稿")).toBeVisible();
    // 不出现任何审批文案或入口。
    await expect(page.getByText("待审批")).toHaveCount(0);
    await expect(page.getByText("提交审批")).toHaveCount(0);

    // 2. 依据抽屉：成本底线 / 毛利 / 历史成交。
    await page.getByRole("button", { name: "查看报价依据" }).click();
    await expect(page.getByText("报价依据（实时查）")).toBeVisible();
    await expect(page.getByText("样品成本底线")).toBeVisible();
    await expect(page.getByText("¥12.00").first()).toBeVisible();
    await expect(page.getByText("毛利空间")).toBeVisible();
    await screenshot(page, testInfo, "journey-a-basis");

    // 3. 改价 18 → 20，看到「原价 → 新价 → 差额」。
    await page.getByLabel("改第 1 行单价").fill("20");
    await page.getByPlaceholder("改价原因（可不填）").fill("客户目标价");
    await page.getByRole("button", { name: "保存新价格" }).click();
    await expect(page.getByText("本次改价")).toBeVisible();
    await expect(page.locator("span.line-through").first()).toHaveText("¥18.00");
    await expect(page.getByText("+¥2.00")).toBeVisible();

    // 4. 确认价格（无审批），复制文本。
    await page.getByRole("button", { name: "确认价格" }).click();
    await expect(page.getByText("已确认价格").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("发给客户的文本")).toBeVisible();
    const copyText = await page.locator("pre").first().innerText();
    for (const piece of [
      "报价单",
      customer.customer.name,
      "100 米",
      "¥20.00",
      "¥2,000.00",
      "有效期",
    ]) {
      expect(copyText).toContain(piece);
    }
    await page.getByRole("button", { name: "一键复制" }).click();
    await expect(page.getByRole("status")).toContainText("已复制");
    await screenshot(page, testInfo, "journey-a-confirmed");

    // 5. 幂等：同一幂等键重复确认返回同一结果，不产生第二条确认审计。
    const secondItem = await request.post(`${API_URL}/api/items`, {
      headers,
      data: {
        customerId: customer.customer.id,
        sampleId: sample.id,
        quantity: { value: 50, unit: "meter" },
      },
    });
    expect(secondItem.ok(), await secondItem.text()).toBe(true);
    const secondItemId = ((await secondItem.json()) as { item: { id: string } }).item.id;
    const secondQuote = await request.post(`${API_URL}/api/items/${secondItemId}/quotes`, {
      headers,
      data: { unitPrice: { amount: 1900, currency: "CNY" } },
    });
    expect(secondQuote.ok(), await secondQuote.text()).toBe(true);
    const secondQuoteBody = (await secondQuote.json()) as {
      draft: { id: string };
      version: number;
    };
    const idempotency = { idempotencyKey: `e2e-confirm-${suffix}-0001` };
    const firstConfirm = await request.post(
      `${API_URL}/api/quotes/${secondQuoteBody.draft.id}/confirm`,
      { headers, data: idempotency },
    );
    const secondConfirm = await request.post(
      `${API_URL}/api/quotes/${secondQuoteBody.draft.id}/confirm`,
      { headers, data: idempotency },
    );
    expect(firstConfirm.ok(), await firstConfirm.text()).toBe(true);
    expect(secondConfirm.ok(), await secondConfirm.text()).toBe(true);
    const firstBody = (await firstConfirm.json()) as Record<string, unknown>;
    const secondBody = (await secondConfirm.json()) as Record<string, unknown>;
    expect(secondBody).toEqual(firstBody);
    expect(firstBody.status).toBe("SENT");

    // 6. 事项完成：有已确认报价才允许。
    await page.goto(`/items/${itemId}`);
    await page.getByRole("button", { name: "标记完成" }).click();
    await expect(page.getByText("事项已完成")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("价格已定稿")).toBeVisible();
    await expect(page.getByText("已确认价格")).toBeVisible();
    await screenshot(page, testInfo, "journey-a-completed");
  });
});
