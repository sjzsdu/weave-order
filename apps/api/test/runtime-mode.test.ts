import { describe, expect, it } from "vitest";
import { isProductionLike as sharedIsProductionLike } from "@weave-order/schema";
import { isProductionLike } from "../src/platform/runtime-mode";

/**
 * 行为表在 `packages/schema/test/runtime-mode.test.ts`（唯一事实源的测试）。
 * 这里只守一件事：api 的 `isProductionLike` 必须是 schema 那一个函数本身，
 * 而不是某个模块里重新写的一份「看起来一样」的 OR 条件。
 */
describe("api 生产态判定直接复用 @weave-order/schema", () => {
  it("api 导出与共享实现是同一个函数引用", () => {
    expect(isProductionLike).toBe(sharedIsProductionLike);
  });
});
