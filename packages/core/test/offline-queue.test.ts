import { describe, expect, it, vi } from "vitest";
import { createOfflineQueue, memoryStorage } from "../src/offline-queue";

const now = () => new Date("2026-11-12T00:00:00.000Z");

describe("离线队列（顺序提交 / 冲突保留）", () => {
  it("按入队顺序提交，成功后移出队列", async () => {
    const storage = memoryStorage();
    const queue = createOfflineQueue(storage);
    await queue.enqueue({ opId: "op-1", kind: "quote.decide", payload: {}, now });
    await queue.enqueue({ opId: "op-2", kind: "quote.decide", payload: {}, now });

    const submitted: string[] = [];
    const result = await queue.flush({
      submit: (op) => {
        submitted.push(op.opId);
        return Promise.resolve();
      },
    });

    expect(submitted).toEqual(["op-1", "op-2"]);
    expect(result).toEqual({ sent: 2, conflicts: 0, failed: 0 });
    expect(await queue.list()).toHaveLength(0);
  });

  it("opId 幂等：重复入队不会产生第二条", async () => {
    const queue = createOfflineQueue(memoryStorage());
    await queue.enqueue({ opId: "op-1", kind: "a", payload: { n: 1 }, now });
    await queue.enqueue({ opId: "op-1", kind: "a", payload: { n: 2 }, now });
    const items = await queue.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.payload).toEqual({ n: 1 });
  });

  it("版本冲突标记 conflict 并继续，其他失败则停止", async () => {
    const queue = createOfflineQueue(memoryStorage());
    await queue.enqueue({ opId: "a", kind: "x", payload: {}, now });
    await queue.enqueue({ opId: "b", kind: "x", payload: {}, now });
    await queue.enqueue({ opId: "c", kind: "x", payload: {}, now });

    const submit = vi.fn((op: { opId: string }) => {
      if (op.opId === "a") throw new Error("VERSION_CONFLICT");
      if (op.opId === "b") throw new Error("NETWORK");
      return Promise.resolve();
    });
    const result = await queue.flush({
      submit,
      isConflict: (error) => error instanceof Error && error.message === "VERSION_CONFLICT",
    });

    expect(result).toEqual({ sent: 0, conflicts: 1, failed: 1 });
    const items = await queue.list();
    expect(items.map((item) => [item.opId, item.status, item.attempts])).toEqual([
      ["a", "conflict", 1],
      ["b", "pending", 1],
      ["c", "pending", 0],
    ]);
  });

  it("已冲突的操作不会再次自动提交", async () => {
    const queue = createOfflineQueue(memoryStorage());
    await queue.enqueue({ opId: "a", kind: "x", payload: {}, now });
    await queue.flush({
      submit: () => Promise.reject(new Error("conflict")),
      isConflict: () => true,
    });
    const submit = vi.fn(() => Promise.resolve());
    const second = await queue.flush({ submit });
    expect(submit).not.toHaveBeenCalled();
    expect(second.sent).toBe(0);
  });
});
