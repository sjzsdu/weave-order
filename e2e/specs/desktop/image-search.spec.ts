import { readFile } from "node:fs/promises";
import { expect, test } from "../../support/test";
import { API_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { openGallery, screenshot } from "../../support/ui";

interface SearchResponse {
  ok: boolean;
  data?: {
    mode: string;
    semantic: boolean;
    indexing: number;
    matches: {
      sample: { code: string; name: string; primaryImageUrl: string | null };
      score: number;
      matchedImageUrl: string | null;
    }[];
  };
  error?: { message: string };
}

/**
 * 桌面「以图找样」：setInputFiles 上传查询图 → 真实 presign/PUT → T-001 图向量检索 → top-5。
 *
 * 种子把同一张图挂到 5 个样品上：local-stub（哈希向量）下同图余弦也是 1.0，
 * 所以「top-5、每条带 matchedImageUrl」在无外部 key 的本地也能成立；
 * 真实多模态模型下同样成立（且分数有语义）。没有 test.skip。
 */
test.describe("以图找样", () => {
  test("上传查询图返回 top-5，每条带命中缩略图", async ({ page }, testInfo) => {
    const seed = await readSeed();
    await openGallery(page, "E2E-FAB", 1);

    await page.getByTestId("open-image-search").click();
    const panel = page.getByTestId("image-search-panel");
    await expect(panel).toBeVisible();

    const searchResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/tools/search-by-image") &&
        response.request().method() === "POST",
    );
    await panel.getByTestId("image-search-input").setInputFiles(seed.fixture);

    const response = await searchResponse;
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as SearchResponse;
    expect(body.ok).toBe(true);
    if (!body.data) throw new Error(`找样失败：${body.error?.message ?? "unknown"}`);
    const data = body.data;

    expect(data.mode).toBe("image");
    expect(data.matches).toHaveLength(5);
    // 10 个样品共用同一张图，分数并列最高；top-5 必须全部来自这组种子，
    // 不能混进库里其它图片（不依赖真实模型也有区分度）。
    const codes = data.matches.map((match) => match.sample.code);
    expect(new Set(codes).size).toBe(5);
    for (const code of codes) expect(seed.sharedImageCodes).toContain(code);
    for (const match of data.matches) {
      expect(match.matchedImageUrl, "每条候选必须有命中的具体一张图").toBeTruthy();
      expect(match.score).toBeGreaterThan(0);
    }

    // 页面把命中图渲染出来了（不是只有文案）。
    const cards = panel.getByTestId("image-match");
    await expect(cards).toHaveCount(5);
    const thumbs = panel.getByTestId("image-match-thumb");
    await expect(thumbs).toHaveCount(5);
    for (let index = 0; index < 5; index += 1) {
      const natural = await thumbs.nth(index).evaluate((element) => {
        const image = element as HTMLImageElement;
        return { complete: image.complete, width: image.naturalWidth };
      });
      expect(natural.complete).toBe(true);
      expect(natural.width).toBeGreaterThan(0);
    }
    // 语义状态必须如实标注：local-stub → 演示模式；真实模型 → 真实图向量。
    if (data.semantic) {
      await expect(panel.getByTestId("image-search-mode")).toContainText("真实图向量");
    } else {
      await expect(panel.getByTestId("image-search-mode")).toContainText("演示模式");
    }

    await screenshot(page, testInfo, "image-search");
  });

  /**
   * 孤儿查询图（已知盲区收尾）：桌面找样的 presign 不带 sampleId，
   * 查询图落在 `tenant/<tid>/uploads/`，而回收任务只扫 `samples/`。
   * 自动化能断言的部分：上传不报错、不产生半挂载样品、连续多张孤儿图之后找样仍然可用。
   * 「对象最终被谁回收」需要对象存储生命周期策略，见 docs/e2e-acceptance.md。
   */
  test("查询图落在 uploads/ 的孤儿不报错、不阻塞找样", async ({ request }) => {
    const seed = await readSeed();
    const authorization = `Bearer ${seed.ownerCredential}`;
    const bytes = await readFile(seed.fixture);
    const uploadsPrefix = new RegExp(`^tenant/${seed.tenantId}/uploads/[0-9a-fA-F-]{36}\\.jpg$`);

    // 连续传两张（模拟用户反复试不同照片），每张都走一次真实找样。
    for (let round = 0; round < 2; round += 1) {
      const presign = await request.post(`${API_URL}/api/media/presign`, {
        headers: { Authorization: authorization },
        data: { mimeType: "image/jpeg", byteSize: bytes.length },
      });
      expect(presign.ok()).toBe(true);
      const presigned = (await presign.json()) as {
        objectKey: string;
        uploadUrl: string;
        publicUrl: string;
        headers: Record<string, string>;
      };
      // 没有 sampleId → key 必须落在 uploads/，而不是被悄悄塞进某个样品。
      expect(presigned.objectKey).toMatch(uploadsPrefix);

      const put = await request.put(presigned.uploadUrl, {
        headers: { ...presigned.headers, "Content-Type": "image/jpeg" },
        data: bytes,
      });
      expect(put.ok()).toBe(true);

      const search = await request.post(`${API_URL}/api/tools/search-by-image`, {
        headers: { Authorization: authorization },
        data: { imageUrl: presigned.publicUrl },
      });
      expect(search.ok()).toBe(true);
      const body = (await search.json()) as {
        ok: boolean;
        data?: { matches: { sample: { code: string } }[] };
        error?: { message: string };
      };
      expect(body.ok, body.error?.message).toBe(true);
      // 找样结果不受孤儿图影响：仍然能命中种子样品。
      expect(body.data?.matches.length ?? 0).toBeGreaterThan(0);
      expect(body.data?.matches.map((match) => match.sample.code)).toContain(
        seed.sharedImageCodes[0],
      );
    }
  });
});
