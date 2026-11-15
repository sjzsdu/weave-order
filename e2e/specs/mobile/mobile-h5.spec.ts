import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { API_URL, MEDIA_BASE_URL } from "../../support/env";
import { readSeed } from "../../support/seed";
import { screenshot } from "../../support/ui";

/**
 * 移动端 H5（Taro 真机构建产物，不是 mock）：
 * 相机拍照建样品 → 样品图墙 → 详情 → 拍照找样。
 *
 * 相机权限与真实快门只能由人完成（见 docs/e2e-acceptance.md）；
 * 这里用 setInputFiles 喂一张真实 JPEG 给 Taro 的 chooseImage，
 * 覆盖「选图 → 压缩 → presign → 直传 → 创建/检索」的全部代码路径。
 */
test.describe("移动端 H5 关键路径", () => {
  test.beforeEach(async ({ page }) => {
    /*
     * Headless Chromium 打开带 `capture` 的文件选择器会立刻 cancel，
     * Taro 的 chooseImage 随即在 finally 里移除 #taroChooseImage。
     * 这里只拦「原生 input.click()」这一步（不碰业务代码），
     * 让 input 留在 DOM 里，由 setInputFiles 触发的 change 事件走完同一条链路。
     */
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- 只保存原型方法，下面用 call 绑定 this
      const originalClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === "file") return;
        originalClick.call(this);
      };
    });
    // 移动端没有 BFF：API 走跨域，测试在请求层补 dev 令牌与「已选公司」会话
    // （页面代码零改动）。多租户账号缺 weave_sid 时业务请求会 401。
    const seed = await readSeed();
    await page.route("**/api/**", async (route) => {
      const headers = {
        ...route.request().headers(),
        authorization: `Bearer ${seed.ownerCredential}`,
      };
      await route.continue({ headers });
    });
  });

  test("拍照建样品 → 图墙 → 详情 → 拍照找样", async ({ page }, testInfo) => {
    const name = `E2E 移动端 ${Date.now().toString(36)}`;

    // 1) 相机 → 建样品
    await page.goto("/");
    // Taro 的 H5 导航栏标题是隐藏的 DOM，不能拿它当「页面已加载」的信号。
    await expect(page.locator(".weui-tabbar__label").first()).toBeVisible();
    await expect(page.getByText("织序 · 现场决定")).toBeVisible();

    // 每轮生成一张像素唯一的图：历史跑批留下的「同一张图」样本不会和本轮并列 1.0，
    // 否则 local-stub 下 top-5 取哪 5 个是任意的，断言会随跑批次数漂移。
    const mobileImage = await uniqueQueryImage(page);
    await openTab(page, "相机");
    await page.getByText("建样品", { exact: true }).click();
    await pickFile(page, "打开相机", mobileImage);
    await expect(page.getByText(/320×320/)).toBeVisible();
    // Taro Input 是 <taro-input-core> 包一个真 <input>，按 placeholder 会命中两个元素。
    await page.locator('input.weui-input[placeholder="如 32S 精梳棉汗布"]').fill(name);
    await page.getByText("保存到样品库", { exact: true }).click();
    const successText = page.getByText(new RegExp(`已建样品「${escapeRegExp(name)}」`));
    await expect(successText).toBeVisible({ timeout: 60_000 });
    // 服务端生成的编码在成功文案里（SP-…），图墙/详情用编码核对同一条记录。
    const createdCode = (await successText.innerText()).match(/(SP-[A-Z0-9-]+)/)?.[1];
    if (!createdCode) throw new Error("成功文案里没有编码");
    await screenshot(page, testInfo, "mobile-created-sample");

    // 2) 图墙 → 详情
    await openTab(page, "更多");
    await page.getByText("样品库", { exact: true }).click();
    await expect(page.getByText("样品库", { exact: true }).first()).toBeVisible();
    const card = page.getByText(name, { exact: true }).first();
    await card.waitFor({ state: "visible", timeout: 30_000 });
    await card.click();
    await expect(page.getByText("样品详情", { exact: true })).toBeVisible();
    const sheet = page.locator(".sheet");
    await expect(sheet.getByText("编码", { exact: true })).toBeVisible();
    await expect(sheet.getByText(createdCode, { exact: true })).toBeVisible();
    const sheetImage = sheet.locator("img").first();
    await expect(sheetImage).toBeVisible();
    const imageState = await sheetImage.evaluate((element) => {
      const image = element as HTMLImageElement;
      return { complete: image.complete, width: image.naturalWidth };
    });
    expect(imageState.complete).toBe(true);
    expect(imageState.width).toBeGreaterThan(0);
    await screenshot(page, testInfo, "mobile-sample-detail");
    await page.getByText("关闭", { exact: true }).click();

    // 3) 无横向滚动（375 级别的移动视口）
    const metrics = await page.evaluate(() => {
      const scrolling = document.scrollingElement;
      return scrolling
        ? { scrollWidth: scrolling.scrollWidth, clientWidth: scrolling.clientWidth }
        : null;
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.scrollWidth).toBeLessThanOrEqual(metrics!.clientWidth);

    // 4) 拍照找样：同一张图 → 服务端返回候选 + 命中缩略图
    // 样品库是 navigateTo 进来的，tabBar 已隐藏：先返回再切 tab。
    await page.goBack();
    await openTab(page, "相机");
    await page.getByText("找样", { exact: true }).click();
    const searchResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/tools/search-by-image") &&
        response.request().method() === "POST",
    );
    await pickFile(page, "从相册", mobileImage);
    const response = await searchResponse;
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      ok: boolean;
      data?: {
        semantic: boolean;
        mode: string;
        matches: { matchedImageUrl: string | null; sample: { name: string } }[];
      };
      error?: { message: string };
    };
    expect(body.ok, body.error?.message).toBe(true);
    const matches = body.data?.matches ?? [];
    // topK=5 的契约：最多 5 条；本轮唯一纹理图在 local-stub 与真实模型下都应命中，
    // 至少 1 条（真实模型下其余候选取决于相似度阈值，不强行凑满 5）。
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.length).toBeLessThanOrEqual(5);
    for (const match of matches) {
      expect(match.matchedImageUrl, "候选必须带命中的那张图").toBeTruthy();
    }
    // 这张图刚通过移动端创建，local-stub 下同图余弦为 1.0，必须出现在候选里。
    expect(matches.map((match) => match.sample.name)).toContain(name);

    await expect(page.getByText("候选面料", { exact: false })).toBeVisible({ timeout: 30_000 });
    // 候选卡片上的缩略图来自对象存储（matchedImageUrl），不是占位色块。
    const candidateThumbs = page.locator(`img[src^="${MEDIA_BASE_URL}"]`);
    await expect(candidateThumbs.first()).toBeVisible();
    await candidateThumbs.first().scrollIntoViewIfNeeded();
    // local-stub 必须显示「演示模式」，不能把哈希分数说成视觉相似。
    if (body.data && !body.data.semantic) {
      await expect(page.getByText("演示模式", { exact: true })).toBeVisible();
    }
    await screenshot(page, testInfo, "mobile-image-search");
  });

  /**
   * 移动端鉴权注入（已知盲区收尾）：H5 没有 BFF，令牌由请求层补上。
   * 这里不改页面代码，直接断言这条注入真的生效：
   * - 页面里不带任何 Authorization 的 fetch 仍能拿到 200（说明注入层在工作）；
   * - 本次运行中所有 `/api/**` 请求都带了令牌；
   * - 同一地址绕过注入（APIRequestContext 不经过 page.route）则是 401。
   * 真实 OIDC 令牌获取仍需部署环境验证，见 docs/e2e-acceptance.md。
   */
  test("鉴权注入生效：页面请求带令牌，无令牌的直连被拒", async ({ page }) => {
    const seed = await readSeed();

    await page.goto("/");
    await expect(page.locator(".weui-tabbar__label").first()).toBeVisible();

    // 令牌本身对应的身份（直接带令牌请求，不经过注入层）。
    const direct = await page.request.get(`${API_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${seed.ownerCredential}` },
    });
    expect(direct.ok()).toBe(true);
    const directIdentity = (await direct.json()) as { subject: string };
    expect(directIdentity.subject).toBeTruthy();

    /*
     * 页面里主动发一次「没有头」的请求：能拿到同一个 subject，
     * 说明 `page.route` 的注入层确实把令牌加上了（否则会落到 dev 匿名上下文）。
     * 不看 `request.headers()`：那里是 route.continue 改写前的原始头，
     * 拿它判断会得到假阴性（WAN-131 实测）。
     */
    const injected = await page.evaluate(async (apiUrl) => {
      const response = await fetch(`${apiUrl}/api/auth/me`);
      return { status: response.status, body: (await response.json()) as { subject?: string } };
    }, API_URL);
    expect(injected.status).toBe(200);
    expect(injected.body.subject).toBe(directIdentity.subject);

    // 认证链路本身是开的：伪造令牌不会被 dev 兜底吞掉，必须 401。
    const forged = await page.request.get(`${API_URL}/api/samples?limit=1`, {
      headers: { Authorization: "Bearer definitely-not-a-session" },
    });
    expect(forged.status()).toBe(401);
  });
});

async function openTab(page: Page, label: string): Promise<void> {
  await page.locator(".weui-tabbar__label", { hasText: label }).click();
}

/**
 * 点按钮 → 给 Taro chooseImage 动态插入的 `<input type=file>` 喂真实文件。
 *
 * 不依赖原生文件选择器（headless 下 capture 属性会拦住它）：
 * Taro H5 的 chooseImage 会创建 `#taroChooseImage` 并等 change 事件，
 * setInputFiles 直接触发同一条代码路径 —— 等价于用户拍照/选图后确认。
 */
interface QueryImage {
  name: string;
  mimeType: "image/jpeg";
  buffer: Buffer;
}

async function pickFile(page: Page, button: string, file: string | QueryImage): Promise<void> {
  await page.getByText(button, { exact: true }).click();
  const input = page.locator("#taroChooseImage");
  await input.waitFor({ state: "attached" });
  await input.setInputFiles(file);
}

/** 在浏览器里画一张随机纹理图，导出 JPEG buffer 供两次 setInputFiles 使用。 */
async function uniqueQueryImage(page: Page): Promise<QueryImage> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas 不可用");
    for (let index = 0; index < 120; index += 1) {
      context.fillStyle = `hsl(${Math.floor(Math.random() * 360)}, 60%, ${30 + Math.floor(Math.random() * 50)}%)`;
      context.fillRect(
        Math.floor(Math.random() * 320),
        Math.floor(Math.random() * 320),
        8 + Math.floor(Math.random() * 40),
        8 + Math.floor(Math.random() * 40),
      );
    }
    return canvas.toDataURL("image/jpeg", 0.9).split(",")[1] ?? "";
  });
  return {
    name: `mobile-query-${Date.now()}.jpg`,
    mimeType: "image/jpeg",
    buffer: Buffer.from(base64, "base64"),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
