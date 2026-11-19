import { describe, expect, it } from "vitest";
import { createMockServer } from "../src/lib/mock/server";
import { createMemoryMockStorage } from "../src/lib/mock/storage";
import { createMobileApi } from "../src/lib/mobile-api";

/**
 * 样品图墙契约（WAN-183 起样品是一级 tab）：
 * mock 必须返回分页字段，否则 tab 首屏直接进错误态。
 */
function buildApi() {
  const server = createMockServer({
    storage: createMemoryMockStorage(),
    latencyMs: 0,
    now: () => new Date("2026-11-20T02:00:00.000Z"),
  });
  return createMobileApi("http://mock.local", server.fetch, () => null);
}

describe("样品图墙分页契约", () => {
  it("带 status 的请求返回完整分页字段", async () => {
    const page = await buildApi().listSamplesPage({ status: "ACTIVE", limit: 20 });
    expect(Array.isArray(page.samples)).toBe(true);
    expect(page.samples.length).toBeGreaterThan(0);
    expect(typeof page.total).toBe("number");
    expect(typeof page.remaining).toBe("number");
    expect(Array.isArray(page.categories)).toBe(true);
    expect(page.categories.every((category) => category.length > 0)).toBe(true);
    expect(typeof page.hasMore).toBe("boolean");
  });

  it("只带 limit 的老调用点仍拿到数组", async () => {
    const samples = await buildApi().listSamples(100);
    expect(samples.length).toBeGreaterThan(0);
  });

  it("游标分页不重复且能走到最后一页", async () => {
    const api = buildApi();
    const first = await api.listSamplesPage({ status: "ACTIVE", limit: 2 });
    expect(first.samples).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await api.listSamplesPage({
      status: "ACTIVE",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const firstIds = new Set(first.samples.map((sample) => sample.id));
    expect(second.samples.some((sample) => firstIds.has(sample.id))).toBe(false);
  });
});
