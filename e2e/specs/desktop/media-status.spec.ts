import { expect, test } from "../../support/test";
import { API_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { openGallery, openSample, screenshot } from "../../support/ui";

/**
 * 媒体状态可见性（WAN-131）：列表与详情都要如实说出「图还没好」或「图坏了」。
 *
 * 两态分别用不同方式制造：
 * - 失败态是真实链路：上传一个「mime 是 jpeg、内容不是图片」的对象，
 *   服务端 HEAD 能通过，但 sharp 解码失败 → `thumb_status=failed` + 原因落库；
 * - 进行中（pending）是瞬态，后台 worker 通常几毫秒就跑完，无法稳定复现，
 *   因此用响应改写固定住 `index_status/thumb_status=pending` —— 只验证 UI 契约，
 *   不验证服务端状态机（后者已有集成测试）。
 */

const BROKEN_BYTES = Buffer.from("WAN-131 not really a jpeg");

test.describe("媒体状态可见性", () => {
  test("缩略图失败在卡片角标与详情徽标上都可见，并可重试", async ({ page, request }, testInfo) => {
    const seed = await readSeed();
    const auth = { Authorization: `Bearer ${seed.ownerCredential}` };
    const code = `E2E-BAD-${Date.now().toString(36).toUpperCase()}`;

    // 1) 建一个空样品，拿到 sampleId（presign 带 sampleId 才落在 samples/ 下）。
    const created = await request.post(`${API_URL}/api/samples`, {
      headers: auth,
      data: { code, name: `坏图验收 ${code}`, unit: "meter" },
    });
    expect(created.ok()).toBe(true);
    const sampleId = ((await created.json()) as { sample: { id: string } }).sample.id;

    // 2) 直传一个「扩展名/Content-Type 合法、内容不是图片」的对象。
    const presign = await request.post(`${API_URL}/api/media/presign`, {
      headers: auth,
      data: { mimeType: "image/jpeg", byteSize: BROKEN_BYTES.length, sampleId },
    });
    expect(presign.ok()).toBe(true);
    const presigned = (await presign.json()) as {
      uploadUrl: string;
      objectKey: string;
      headers: Record<string, string>;
    };
    const put = await request.put(presigned.uploadUrl, {
      headers: { ...presigned.headers, "Content-Type": "image/jpeg" },
      data: BROKEN_BYTES,
    });
    expect(put.ok()).toBe(true);

    // 3) 挂到样品上：缩略图派生在提交后同步执行，失败必须落在读模型里。
    const patched = await request.patch(`${API_URL}/api/samples/${sampleId}`, {
      headers: auth,
      data: { imageKeys: [presigned.objectKey], primaryImageKey: presigned.objectKey },
    });
    expect(patched.ok()).toBe(true);
    const patchedSample = (await patched.json()) as {
      sample: { images: { thumbStatus: string; thumbError: string | null }[] };
    };
    expect(patchedSample.sample.images[0]?.thumbStatus).toBe("failed");
    expect(patchedSample.sample.images[0]?.thumbError).toBeTruthy();

    // 4) 图墙：主图缩略图没就绪 → 卡片角标（而不是每张图都加噪声）。
    await openGallery(page, code, 1);
    const card = page.locator("main ul.grid-cols-2 > li").filter({ hasText: code }).first();
    await expect(card.getByTestId("sample-thumb-badge")).toContainText("缩略图失败");

    // 5) 详情抽屉：失败徽标 + 服务端原因 + 重试入口。
    await card.locator("button").first().click();
    const drawer = page.locator("aside");
    await expect(drawer.getByText("成本底线")).toBeVisible();
    const status = drawer.getByTestId("image-status");
    await expect(status).toContainText("缩略图失败");
    // 原因原样展示，不把「AI 觉得」之类的推断写成解释。
    await expect(status).toContainText("缩略图失败：");
    await expect(status.getByTestId("image-retry")).toBeVisible();
    await screenshot(page, testInfo, "media-status-failed");

    // 6) 重试会真的重跑（POST → 200）：坏图仍然失败，但界面不能崩、原因不能丢。
    const retryResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/samples/${sampleId}/images/`) &&
        response.url().endsWith("/retry") &&
        response.request().method() === "POST",
    );
    await status.getByTestId("image-retry").click();
    const retried = await retryResponse;
    expect(retried.status()).toBe(200);
    await expect(drawer.getByTestId("image-status")).toContainText("缩略图失败");
    await expect(drawer.getByTestId("image-status")).toContainText("缩略图失败：");
  });

  test("进行中状态显示为「索引中 / 缩略图生成中」，且不提供重试", async ({ page }, testInfo) => {
    const seed = await readSeed();
    const sample = seed.carouselSample;

    // 只改写详情响应（列表不动），把两张图钉在 pending 态。
    await page.route(/\/api\/samples\/[0-9a-f-]{36}$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        sample: { images: Record<string, unknown>[] };
      };
      body.sample.images = body.sample.images.map((image) => ({
        ...image,
        indexStatus: "pending",
        indexError: null,
        thumbStatus: "pending",
        thumbError: null,
        detailUrl: null,
      }));
      await route.fulfill({ response, json: body });
    });

    await openSample(page, sample);
    const status = page.locator("aside").getByTestId("image-status");
    await expect(status).toContainText("索引中");
    await expect(status).toContainText("缩略图生成中");
    await expect(status.getByTestId("image-retry")).toHaveCount(0);
    // 进行中不是失败：不能出现红色失败文案。
    await expect(status).not.toContainText("索引失败");
    await expect(status).not.toContainText("缩略图失败");
    await screenshot(page, testInfo, "media-status-pending");
  });
});
