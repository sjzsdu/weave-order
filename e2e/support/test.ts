import { test as base } from "@playwright/test";
import { readSeed } from "./seed";

/**
 * 桌面用例的统一 test：在 config 的 owner storageState（weave_token）之上，
 * 补一条 `weave_sid` —— 多租户账号（本地/共享库里 demo 属于两个公司）
 * 没有「已选公司」的会话时，所有业务请求都会是 401，页面停在公司选择页。
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    const seed = await readSeed();
    if (seed.ownerSid) {
      await context.addCookies([
        {
          name: "weave_sid",
          value: seed.ownerSid,
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ]);
    }
    await use(context);
  },
});

export { expect } from "@playwright/test";
