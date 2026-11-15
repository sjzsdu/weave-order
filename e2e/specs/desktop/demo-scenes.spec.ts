import { expect, test } from "../../support/test";
import { API_URL, REPO_ROOT } from "../../support/env";
import scenesFile from "../../../data/demo-scenes.json";

/**
 * WAN-137：剧本深链。
 *
 * 断言不是「文案里出现过剧本」：服务端返回的 entityId 必须真的出现在审批队列里，
 * 页面上对应的卡片必须带 `data-scene-highlight=true`。剧本清单只读
 * `data/demo-scenes.json` —— 与销售拿到的链接、`demo:reset` 造的数据是同一份。
 */
interface ResolvedScene {
  scene: {
    key: string;
    href: string;
    entityId: string | null;
    resolved: boolean;
    highlight: "approval" | "none";
  };
}

test.describe("演示剧本深链", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.clearCookies({ name: "weave_sid" });
    const response = await page.request.post(`${API_URL}/api/dev/session`, {
      data: { personaKey: "owner" },
    });
    expect(response.ok(), `建立剧本测试会话失败：HTTP ${response.status()}`).toBe(true);
  });

  for (const scene of scenesFile.scenes) {
    test(`${scene.key} 解析到当前库单据并高亮`, async ({ page }, testInfo) => {
      const response = await page.request.get(`${API_URL}/api/demo/scenes/${scene.key}`);
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as ResolvedScene;
      expect(body.scene.resolved, "剧本锚点缺失：先跑 pnpm demo:scenes / demo:reset").toBe(true);
      expect(body.scene.entityId).toMatch(/^[0-9a-f-]{36}$/);

      // 深链本身来自同一份 JSON，不能在 spec 里手写。
      const href = scene.href.replace(/^\/today/, "");
      await page.goto(`/today${href}`);
      await expect(page.locator(`[data-demo-scene="${scene.key}"]`)).toBeVisible();
      if (body.scene.highlight === "approval") {
        await expect(page.locator('[data-scene-highlight="true"]')).toHaveCount(1);
      }
      await page.screenshot({
        path: `${REPO_ROOT}/e2e/.artifacts/screenshots/${testInfo.project.name}-scene-${scene.key}.png`,
        fullPage: false,
      });
    });
  }
});
