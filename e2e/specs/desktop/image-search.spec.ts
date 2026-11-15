import { expect, test } from "../../support/test";
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
});
